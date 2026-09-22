import {
  CoreErrorType,
  TEAM_MERGE_TOOL_NAME,
  TeamMergeInputJsonSchema,
  TeamMergeInputSchema,
  TeamMergeOutputSchema,
  createCoreError,
  isLeadTeamPort,
  type TeamMergeInput,
  type TeamMergeOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TEAM_MERGE_MODEL_BYTES = 8_192;

const TEAM_MERGE_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    task_id: { type: "string" },
    rejection: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TEAM_MERGE_PROVIDER_DESCRIPTION = [
  "# team_merge",
  "",
  "Merge a completed task's owner branch into the main checkout through the merge gate. Lead only.",
  "",
  "```json",
  '{"task_id": "1"}',
  "```",
  "",
  "Mechanical checks before merging: task completed, owner has an isolated worktree, owner holds no in-progress task, both worktrees clean, branch diff inside the completed tasks' scope, main tip not diverged into overlapping files. Each rejection names the reason and the next step. team_collect reports overlapping branches before you merge.",
].join("\n");

const teamMergeHandler: ToolHandler = async (input, context) => {
  const parsed = TeamMergeInputSchema.parse(input) as TeamMergeInput;

  if (!isLeadTeamPort(context.teamPort)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Lead team port is not configured for team_merge",
      {
        context: { toolCallId: context.toolCallId, toolName: TEAM_MERGE_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const result = await context.teamPort.mergeTask({ taskId: parsed.task_id });
  return {
    status: result.status,
    ...(result.taskId !== undefined ? { task_id: result.taskId } : {}),
    ...(result.task !== undefined ? { task: result.task } : {}),
    ...(result.rejection !== undefined ? { rejection: result.rejection } : {}),
    ...(result.mergedFiles !== undefined ? { merged_files: result.mergedFiles } : {}),
    message: result.message,
    ...(result.error !== undefined ? { error: result.error } : {}),
  } satisfies TeamMergeOutput;
};

export const teamMergeToolEntry: ToolEntry = {
  capability: "Merge a completed task's owner branch through the merge gate",
  metadata: {
    name: TEAM_MERGE_TOOL_NAME,
    description: TEAM_MERGE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_TEAM_MERGE_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: teamMergeHandler,
  formatModelContent: formatTeamMergeModelContent,
  inputSchema: TeamMergeInputJsonSchema,
  outputSchema: TEAM_MERGE_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamMergeInputSchema,
  runtimeOutputSchema: TeamMergeOutputSchema,
  permission: {
    permission: "team.merge",
    reason: "team_merge writes teammate branch changes into the main checkout",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_MERGE_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_MERGE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TEAM_MERGE_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: 30_000,
    maxMs: 60_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "team_merge was cancelled; git conflicts are rolled back automatically",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTeamMergeModelContent(output: unknown): string {
  const result = TeamMergeOutputSchema.parse(output);
  if (result.status === "success") {
    return result.message;
  }
  return `Merge rejected (${result.rejection ?? "unknown"}): ${result.error ?? result.message}`;
}
