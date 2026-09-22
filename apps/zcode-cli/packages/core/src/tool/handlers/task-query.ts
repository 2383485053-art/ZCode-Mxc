import {
  CoreErrorType,
  TASK_QUERY_TOOL_NAME,
  TaskQueryInputJsonSchema,
  TaskQueryInputSchema,
  TaskQueryOutputSchema,
  createCoreError,
  type TaskQueryInput,
  type TaskQueryOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TASK_QUERY_MODEL_BYTES = 8_192;

const TASK_QUERY_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TASK_QUERY_PROVIDER_DESCRIPTION = [
  "# task_query",
  "",
  "Show one task from the team board in full (description, dependencies, shared context, worklog path).",
  "",
  "```json",
  '{"task_id": "3"}',
  "```",
].join("\n");

const taskQueryHandler: ToolHandler = async (input, context) => {
  const parsed = TaskQueryInputSchema.parse(input) as TaskQueryInput;

  if (!context.teamPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Team port is not configured for task_query",
      {
        context: { toolCallId: context.toolCallId, toolName: TASK_QUERY_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const result = await context.teamPort.queryTask({ taskId: parsed.task_id });
  return {
    status: result.status,
    ...(result.task !== undefined ? { task: result.task } : {}),
    message: result.message,
    ...(result.error !== undefined ? { error: result.error } : {}),
  } satisfies TaskQueryOutput;
};

export const taskQueryToolEntry: ToolEntry = {
  capability: "Show one task from the team board",
  metadata: {
    name: TASK_QUERY_TOOL_NAME,
    description: TASK_QUERY_PROVIDER_DESCRIPTION,
    allowedInPlanMode: true,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TASK_QUERY_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskQueryHandler,
  formatModelContent: formatTaskQueryModelContent,
  inputSchema: TaskQueryInputJsonSchema,
  outputSchema: TASK_QUERY_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TaskQueryInputSchema,
  runtimeOutputSchema: TaskQueryOutputSchema,
  permission: {
    permission: "team.task.read",
    reason: "task_query reads one task from the team board",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TASK_QUERY_MODEL_BYTES,
    maxModelBytes: MAX_TASK_QUERY_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TASK_QUERY_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "task_query was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTaskQueryModelContent(output: unknown): string {
  const result = TaskQueryOutputSchema.parse(output);
  if (result.status === "failed" || !result.task) {
    return `task_query failed: ${result.error ?? result.message}`;
  }
  const task = result.task;
  const details = [
    `#${task.id} [${task.status}]${task.owner ? ` (${task.owner})` : ""} ${task.subject}`,
    task.description !== undefined ? task.description : undefined,
    task.blockedBy.length > 0 ? `blocked by: ${task.blockedBy.join(", ")}` : undefined,
    task.blocks !== undefined && task.blocks.length > 0 ? `blocks: ${task.blocks.join(", ")}` : undefined,
    task.sharedContext !== undefined && task.sharedContext.length > 0
      ? `shared context: ${task.sharedContext.join(", ")}`
      : undefined,
    task.worklog !== undefined ? `worklog: ${task.worklog}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return details.join("\n");
}
