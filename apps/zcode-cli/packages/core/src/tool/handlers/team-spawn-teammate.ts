import {
  CoreErrorType,
  TEAM_SPAWN_TEAMMATE_TOOL_NAME,
  TeamSpawnTeammateInputJsonSchema,
  TeamSpawnTeammateInputSchema,
  TeamSpawnTeammateOutputSchema,
  createCoreError,
  isLeadTeamPort,
  type TeamSpawnTeammateInput,
  type TeamSpawnTeammateOutput,
  type TraceContext,
} from "@zcode/contracts";
import { assertNotOffPeakTurn } from "./off-peak.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TEAM_SPAWN_MODEL_BYTES = 4_096;

const TEAM_SPAWN_OFF_PEAK_HINT =
  "Spawn teammates from a regular turn, not an idle-time task: teammate runs are billed to the user plan.";

const TEAM_SPAWN_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TEAM_SPAWN_PROVIDER_DESCRIPTION = [
  "# team_spawn_teammate",
  "",
  "Spawn a background teammate into the active team. Returns the updated roster.",
  "",
  "```json",
  '{"name": "reviewer", "profile": "general-purpose"}',
  "```",
  "",
  "Teammates run in the background with a per-run turn budget (default 20). They receive team messages and can message the lead and each other via team_send. Keep teams small (3-5 is the sweet spot).",
  "Writers (readOnly not set) get their own git worktree (requires a git repository); readOnly teammates share the lead's checkout.",
  "Revival: spawning with the name of a dead teammate (after lead takeover or a crash) revives them — the same worktree branch is re-attached and messages that arrived while they were dead are replayed into their briefing.",
].join("\n");

interface SpawnFailure {
  reason: string;
  rolledBack: boolean;
}

const teamSpawnTeammateHandler: ToolHandler = async (input, context) => {
  const parsed = TeamSpawnTeammateInputSchema.parse(input) as TeamSpawnTeammateInput;

  assertNotOffPeakTurn(context, TEAM_SPAWN_TEAMMATE_TOOL_NAME, {
    hint: TEAM_SPAWN_OFF_PEAK_HINT,
    recoverable: true,
  });

  if (!isLeadTeamPort(context.teamPort)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Lead team port is not configured for team_spawn_teammate",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: TEAM_SPAWN_TEAMMATE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }
  const lead = context.teamPort;

  // 占位先行（失败不占名额）；spawn 失败按 qwen #10071 教训回滚 roster。
  const reserve = await lead.reserveMember({
    name: parsed.name,
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    ...(parsed.readOnly !== undefined ? { readOnly: parsed.readOnly } : {}),
    ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
  });
  if (reserve.status === "failed" || reserve.teamName === undefined) {
    return failedOutput(reserve.error ?? reserve.message);
  }

  if (context.subagentPort?.start === undefined) {
    const rollback = await lead.removeMember(parsed.name, "background spawn is unavailable");
    return failedOutput(
      rollback.status === "failed"
        ? `Teammate reserved but spawn failed and rollback also failed; remove '${parsed.name}' manually. Cause: background spawn is unavailable in this host.`
        : "Background spawn is unavailable in this host.",
    );
  }

  // M2 隔离层：writer 成员先建独立 worktree（readOnly 成员与主 checkout 共存，无树）。
  // 建树失败（如非 git 仓库）如实回滚占位——不静默降级成共享主 checkout 的 writer。
  let memberWorkspace: { worktreePath: string; branch: string } | undefined;
  if (parsed.readOnly !== true) {
    const workspace = await lead.setupMemberWorkspace(parsed.name);
    if (workspace.status === "failed" || workspace.workspace === undefined) {
      const rollback = await lead.removeMember(
        parsed.name,
        "workspace setup failed",
      );
      return failedOutput(
        rollback.status === "failed"
          ? `Teammate workspace setup failed and rollback also failed; remove '${parsed.name}' manually. Cause: ${workspace.error ?? workspace.message}`
          : `Teammate spawn rolled back: ${workspace.error ?? workspace.message}`,
      );
    }
    memberWorkspace = workspace.workspace;
  }

  // M3 复活补送：同名重 spawn 的成员把信箱在途消息并入简报（新 spawn 是全新子会话，
  // 旧投递结局对它无效）；消费标记在 spawn 确认后落——失败则消息留待下次复活再补送。
  const pendingReplay = await lead.readMemberPendingMessages(parsed.name).catch(() => []);
  const replayBriefing =
    pendingReplay.length > 0
      ? `\n\nMessages that arrived while you were away (replayed from your inbox, oldest first):\n${pendingReplay
          .map(
            (message) =>
              `- from ${message.from} (${message.queuedAt}): ${message.summary}\n${message.message}`,
          )
          .join("\n")}`
      : "";

  const briefing = [
    `You are teammate "${parsed.name}" on agent team "${reserve.teamName}".`,
    'Your lead is "lead". Task assignments and messages arrive as team messages; answer or report with team_send.',
    "Work comes from the shared board: task_list shows it; claim an unowned pending task with task_update status=in_progress, finish it with task_update status=completed (the reply names the next claimable task), and pick that up before stopping.",
    ...(memberWorkspace !== undefined
      ? [
          `You work in your own git worktree (${memberWorkspace.branch} at ${memberWorkspace.worktreePath}); your cwd is already there — use relative paths.`,
          "File writes are limited to your current task's scope; out-of-scope or outside-worktree writes are rejected. Do not run git commit/branch yourself — completing a task commits your worktree automatically, and the lead merges your branch.",
        ]
      : [
          "You have no separate worktree and share the lead's checkout: prefer read-only analysis (read/search/list) and report findings via team_send — direct edits would land unisolated in the shared checkout.",
        ]),
    "Teammates are resumed per message: finish your current instructions cleanly and stop; you will be woken when there is more to do.",
    ...(replayBriefing !== "" ? [replayBriefing] : []),
  ].join("\n");

  try {
    const output = await context.subagentPort.start(
      {
        sessionId: context.sessionId,
        ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
        parentToolCallId: context.toolCallId,
        agentType: parsed.profile,
        description: `Team ${reserve.teamName} member ${parsed.name}`,
        prompt: briefing,
        // writer 的 cwd/workspaceRoot 都指向自己的 worktree：相对路径天然落树内。
        workingDirectory: memberWorkspace?.worktreePath ?? context.workingDirectory,
        workspaceRoot: memberWorkspace?.worktreePath ?? context.workspaceRoot,
        trace: resolveToolTraceContext(context),
        teamMemberName: parsed.name,
        ...(parsed.maxTurns === undefined ? {} : { maxTurns: parsed.maxTurns }),
      },
      { signal: context.abortSignal },
    );
    const confirm = await lead.completeMemberSpawn(parsed.name, { agentId: output.agentId });
    if (confirm.status === "failed") {
      // spawn 成功但 roster 确认失败：如实报告，不静默——lead 可 removeMember 重试。
      return {
        status: "failed",
        memberName: parsed.name,
        message: `Teammate spawned (agent ${output.agentId}) but roster confirmation failed: ${confirm.error ?? confirm.message}`,
        error: confirm.error ?? confirm.message,
      } satisfies TeamSpawnTeammateOutput;
    }
    // 复活补送的消费标记：spawn 确认成功才落（best-effort；失败只多留在途一条）。
    if (pendingReplay.length > 0) {
      await lead.markMemberMessagesDelivered(
        parsed.name,
        pendingReplay.map((message) => message.messageId),
      );
    }
    return {
      status: "success",
      teamName: reserve.teamName,
      memberName: parsed.name,
      agentId: output.agentId,
      message: `Teammate '${parsed.name}' spawned in the background (agent ${output.agentId}).`,
      ...(confirm.roster ? { roster: confirm.roster.map(memberRosterView) } : {}),
    } satisfies TeamSpawnTeammateOutput;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const rollback = await lead.removeMember(parsed.name, `spawn failed: ${reason}`);
    const failure: SpawnFailure = { reason, rolledBack: rollback.status === "success" };
    return failedOutput(
      failure.rolledBack
        ? `Teammate spawn failed and the reservation was rolled back. Cause: ${failure.reason}`
        : `Teammate spawn failed and rollback also failed; remove '${parsed.name}' manually. Cause: ${failure.reason}`,
    );
  }
};

function memberRosterView(member: {
  name: string;
  state: string;
  profile?: string;
  readOnly?: boolean;
}): { name: string; state: string; profile?: string; readOnly?: boolean } {
  return {
    name: member.name,
    state: member.state,
    ...(member.profile !== undefined ? { profile: member.profile } : {}),
    ...(member.readOnly !== undefined ? { readOnly: member.readOnly } : {}),
  };
}

function failedOutput(reason: string): TeamSpawnTeammateOutput {
  return { status: "failed", message: reason, error: reason };
}

export const teamSpawnTeammateToolEntry: ToolEntry = {
  capability: "Spawn a background teammate into the active team",
  metadata: {
    name: TEAM_SPAWN_TEAMMATE_TOOL_NAME,
    description: TEAM_SPAWN_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 60_000,
    maxOutputBytes: MAX_TEAM_SPAWN_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: teamSpawnTeammateHandler,
  formatModelContent: formatTeamSpawnModelContent,
  inputSchema: TeamSpawnTeammateInputJsonSchema,
  outputSchema: TEAM_SPAWN_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamSpawnTeammateInputSchema,
  runtimeOutputSchema: TeamSpawnTeammateOutputSchema,
  permission: {
    permission: "team.spawn",
    reason: "team_spawn_teammate launches a background subagent billed to the user plan",
    riskLevel: "medium",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_SPAWN_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_SPAWN_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TEAM_SPAWN_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 60_000,
    maxMs: 120_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "team_spawn_teammate was cancelled; the reservation is rolled back on failure",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTeamSpawnModelContent(output: unknown): string {
  const result = TeamSpawnTeammateOutputSchema.parse(output);
  if (result.status === "success") {
    return `Teammate ${result.memberName ?? ""} spawned (agent ${result.agentId ?? ""}). ${result.message}`;
  }
  return `Teammate spawn failed: ${result.error ?? result.message}`;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
