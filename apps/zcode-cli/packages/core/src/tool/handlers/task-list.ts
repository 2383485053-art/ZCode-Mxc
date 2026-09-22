import {
  CoreErrorType,
  TASK_LIST_TOOL_NAME,
  TaskListInputJsonSchema,
  TaskListInputSchema,
  TaskListOutputSchema,
  createCoreError,
  type TaskListInput,
  type TaskListOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TASK_LIST_MODEL_BYTES = 16_384;

const TASK_LIST_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TASK_LIST_PROVIDER_DESCRIPTION = [
  "# task_list",
  "",
  "List every task on your team's shared board (status, owner, dependencies).",
  "",
  "```json",
  "{}",
  "```",
  "",
  "To pick up work: pick a pending task with no owner whose blocked_by tasks are all completed, then task_update it with status=in_progress. Finish your current task before claiming another.",
].join("\n");

const taskListHandler: ToolHandler = async (input, context) => {
  TaskListInputSchema.parse(input) as TaskListInput;

  if (!context.teamPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Team port is not configured for task_list",
      {
        context: { toolCallId: context.toolCallId, toolName: TASK_LIST_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const result = await context.teamPort.listTasks();
  return {
    status: result.status,
    tasks: result.tasks,
    message: result.message,
    ...(result.error !== undefined ? { error: result.error } : {}),
  } satisfies TaskListOutput;
};

export const taskListToolEntry: ToolEntry = {
  capability: "List the shared team task board",
  metadata: {
    name: TASK_LIST_TOOL_NAME,
    description: TASK_LIST_PROVIDER_DESCRIPTION,
    // plan 模式的团队成员仍须能看板（协调不因 plan 而盲）。
    allowedInPlanMode: true,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TASK_LIST_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskListHandler,
  formatModelContent: formatTaskListModelContent,
  inputSchema: TaskListInputJsonSchema,
  outputSchema: TASK_LIST_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TaskListInputSchema,
  runtimeOutputSchema: TaskListOutputSchema,
  permission: {
    permission: "team.task.read",
    reason: "task_list reads the team board",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TASK_LIST_MODEL_BYTES,
    maxModelBytes: MAX_TASK_LIST_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TASK_LIST_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "task_list was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTaskListModelContent(output: unknown): string {
  const result = TaskListOutputSchema.parse(output);
  if (result.status === "failed") {
    return `task_list failed: ${result.error ?? result.message}`;
  }
  const lines = result.tasks.map(
    (task) =>
      `#${task.id} [${task.status}]${task.owner ? ` (${task.owner})` : ""} ${task.subject}` +
      (task.blockedBy.length > 0 ? ` — blocked by ${task.blockedBy.join(",")}` : ""),
  );
  return [result.message, ...lines].join("\n");
}
