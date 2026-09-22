import {
  CoreErrorType,
  TASK_UPDATE_TOOL_NAME,
  TaskUpdateInputJsonSchema,
  TaskUpdateInputSchema,
  TaskUpdateOutputSchema,
  createCoreError,
  type TaskUpdateInput,
  type TaskUpdateOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TASK_UPDATE_MODEL_BYTES = 8_192;

const TASK_UPDATE_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TASK_UPDATE_PROVIDER_DESCRIPTION = [
  "# task_update",
  "",
  "Claim, complete, release, or reassign a task on the team board.",
  "",
  "```json",
  '{"task_id": "3", "status": "in_progress"}',
  "```",
  "",
  "Members: status=in_progress claims an unowned pending task (owner becomes you; dependencies must be terminal; one in-progress task at a time); status=completed finishes your in_progress task; status=pending releases it back to the board. Lead: may additionally set owner to assign tasks and status=cancelled to cancel.",
].join("\n");

const taskUpdateHandler: ToolHandler = async (input, context) => {
  const parsed = TaskUpdateInputSchema.parse(input) as TaskUpdateInput;

  if (!context.teamPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Team port is not configured for task_update",
      {
        context: { toolCallId: context.toolCallId, toolName: TASK_UPDATE_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const result = await context.teamPort.updateTask({
    taskId: parsed.task_id,
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}),
  });
  return {
    status: result.status,
    ...(result.task !== undefined ? { task: result.task } : {}),
    message: result.message,
    ...(result.error !== undefined ? { error: result.error } : {}),
  } satisfies TaskUpdateOutput;
};

export const taskUpdateToolEntry: ToolEntry = {
  capability: "Claim, complete, release, or reassign a team task",
  metadata: {
    name: TASK_UPDATE_TOOL_NAME,
    description: TASK_UPDATE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TASK_UPDATE_MODEL_BYTES,
    sideEffectScope: "system",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskUpdateHandler,
  formatModelContent: formatTaskUpdateModelContent,
  inputSchema: TaskUpdateInputJsonSchema,
  outputSchema: TASK_UPDATE_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TaskUpdateInputSchema,
  runtimeOutputSchema: TaskUpdateOutputSchema,
  permission: {
    permission: "team.task.update",
    reason: "task_update changes task status/owner on the team board",
    riskLevel: "low",
    sideEffectScope: "system",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TASK_UPDATE_MODEL_BYTES,
    maxModelBytes: MAX_TASK_UPDATE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TASK_UPDATE_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "task_update was cancelled before the board was updated",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTaskUpdateModelContent(output: unknown): string {
  const result = TaskUpdateOutputSchema.parse(output);
  if (result.status === "failed") {
    return `task_update failed: ${result.error ?? result.message}`;
  }
  return result.message;
}
