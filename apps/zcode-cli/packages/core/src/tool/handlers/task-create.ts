import {
  CoreErrorType,
  TASK_CREATE_TOOL_NAME,
  TaskCreateInputJsonSchema,
  TaskCreateInputSchema,
  TaskCreateOutputSchema,
  createCoreError,
  isLeadTeamPort,
  type TaskCreateInput,
  type TaskCreateOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TASK_CREATE_MODEL_BYTES = 8_192;

const TASK_CREATE_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    task_id: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TASK_CREATE_PROVIDER_DESCRIPTION = [
  "# task_create",
  "",
  "Create a task on the team board. Lead only.",
  "",
  "```json",
  '{"subject": "Run the auth test suite", "description": "All tests green; report failures with file:line.", "blocked_by": ["1"], "scope": ["src/auth/**"]}',
  "```",
  "",
  "Subjects are imperative one-liners; description is the acceptance criteria. Teammates claim pending unowned tasks themselves (task_update status=in_progress).",
  "scope pins the write range: scoped tasks run isolated in the writer's worktree and out-of-scope writes are vetoed; scopes of open tasks must not overlap.",
].join("\n");

const taskCreateHandler: ToolHandler = async (input, context) => {
  const parsed = TaskCreateInputSchema.parse(input) as TaskCreateInput;

  if (!isLeadTeamPort(context.teamPort)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Lead team port is not configured for task_create",
      {
        context: { toolCallId: context.toolCallId, toolName: TASK_CREATE_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const result = await context.teamPort.createTask({
    subject: parsed.subject,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.active_form !== undefined ? { activeForm: parsed.active_form } : {}),
    ...(parsed.blocked_by !== undefined ? { blockedBy: parsed.blocked_by } : {}),
    ...(parsed.shared_context !== undefined ? { sharedContext: parsed.shared_context } : {}),
    ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
  });
  return {
    status: result.status,
    ...(result.taskId !== undefined ? { task_id: result.taskId } : {}),
    ...(result.task !== undefined ? { task: result.task } : {}),
    message: result.message,
    ...(result.error !== undefined ? { error: result.error } : {}),
  } satisfies TaskCreateOutput;
};

export const taskCreateToolEntry: ToolEntry = {
  capability: "Create a task on the team board",
  metadata: {
    name: TASK_CREATE_TOOL_NAME,
    description: TASK_CREATE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TASK_CREATE_MODEL_BYTES,
    sideEffectScope: "system",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskCreateHandler,
  formatModelContent: formatTaskCreateModelContent,
  inputSchema: TaskCreateInputJsonSchema,
  outputSchema: TASK_CREATE_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TaskCreateInputSchema,
  runtimeOutputSchema: TaskCreateOutputSchema,
  permission: {
    permission: "team.task.create",
    reason: "task_create writes a task onto the team board",
    riskLevel: "low",
    sideEffectScope: "system",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TASK_CREATE_MODEL_BYTES,
    maxModelBytes: MAX_TASK_CREATE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TASK_CREATE_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "task_create was cancelled before the task was finalized",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTaskCreateModelContent(output: unknown): string {
  const result = TaskCreateOutputSchema.parse(output);
  if (result.status === "success") {
    return result.message;
  }
  return `Task creation failed: ${result.error ?? result.message}`;
}
