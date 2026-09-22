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

  const briefing = [
    `You are teammate "${parsed.name}" on agent team "${reserve.teamName}".`,
    'Your lead is "lead". Task assignments and messages arrive as team messages; answer or report with team_send.',
    "Work comes from the shared board: task_list shows it; claim an unowned pending task with task_update status=in_progress, finish it with task_update status=completed (the reply names the next claimable task), and pick that up before stopping.",
    "Teammates are resumed per message: finish your current instructions cleanly and stop; you will be woken when there is more to do.",
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
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
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
