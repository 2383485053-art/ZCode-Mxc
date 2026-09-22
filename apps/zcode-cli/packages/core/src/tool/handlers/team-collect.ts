import {
  CoreErrorType,
  TEAM_COLLECT_TOOL_NAME,
  TeamCollectInputJsonSchema,
  TeamCollectInputSchema,
  TeamCollectOutputSchema,
  createCoreError,
  isLeadTeamPort,
  type TeamCollectInput,
  type TeamCollectOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TEAM_COLLECT_MODEL_BYTES = 16_384;

const TEAM_COLLECT_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TEAM_COLLECT_PROVIDER_DESCRIPTION = [
  "# team_collect",
  "",
  "Wait for the team's open tasks to finish, then return the board. Lead only.",
  "",
  "```json",
  '{"timeout_ms": 300000, "require_all": true}',
  "```",
  "",
  "Tracks every non-terminal task at call time. require_all=true (default) waits for all of them; false returns as soon as the first finishes. On timeout you get partial results: each task with its current status.",
].join("\n");

const teamCollectHandler: ToolHandler = async (input, context) => {
  const parsed = TeamCollectInputSchema.parse(input) as TeamCollectInput;

  if (!isLeadTeamPort(context.teamPort)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Lead team port is not configured for team_collect",
      {
        context: { toolCallId: context.toolCallId, toolName: TEAM_COLLECT_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const result = await context.teamPort.collectTasks(
    {
      ...(parsed.timeout_ms !== undefined ? { timeoutMs: parsed.timeout_ms } : {}),
      ...(parsed.require_all !== undefined ? { requireAll: parsed.require_all } : {}),
    },
    context.abortSignal,
  );
  return {
    status: result.status,
    tasks: result.tasks,
    message: result.message,
    ...(result.error !== undefined ? { error: result.error } : {}),
  } satisfies TeamCollectOutput;
};

export const teamCollectToolEntry: ToolEntry = {
  capability: "Wait for the team's open tasks and collect results",
  metadata: {
    name: TEAM_COLLECT_TOOL_NAME,
    description: TEAM_COLLECT_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 610_000,
    maxOutputBytes: MAX_TEAM_COLLECT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: teamCollectHandler,
  formatModelContent: formatTeamCollectModelContent,
  inputSchema: TeamCollectInputJsonSchema,
  outputSchema: TEAM_COLLECT_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamCollectInputSchema,
  runtimeOutputSchema: TeamCollectOutputSchema,
  permission: {
    permission: "team.collect",
    reason: "team_collect waits for team tasks and reads the board",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_COLLECT_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_COLLECT_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TEAM_COLLECT_MODEL_BYTES, direction: "head" },
  },
  // 等待类工具同 TaskOutput：deadline 由输入 timeout_ms 自管（上限 600s），不吃统一工具超时。
  timeout: {
    kind: "none",
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "team_collect was cancelled while waiting for the board",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTeamCollectModelContent(output: unknown): string {
  const result = TeamCollectOutputSchema.parse(output);
  if (result.status === "failed") {
    return `team_collect failed: ${result.error ?? result.message}`;
  }
  const lines = result.tasks.map(
    (task) => `#${task.id} [${task.status}]${task.owner ? ` (${task.owner})` : ""} ${task.subject}`,
  );
  return [result.message, ...lines].join("\n");
}
