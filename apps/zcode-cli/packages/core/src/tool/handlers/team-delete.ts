import {
  CoreErrorType,
  TEAM_DELETE_TOOL_NAME,
  TeamDeleteInputJsonSchema,
  TeamDeleteInputSchema,
  TeamDeleteOutputSchema,
  isLeadTeamPort,
  createCoreError,
  type TeamDeleteOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TEAM_DELETE_MODEL_BYTES = 4_096;

const TEAM_DELETE_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string"},
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TEAM_DELETE_PROVIDER_DESCRIPTION = [
  "# team_delete",
  "",
  "Shut down and delete the active team: every teammate's background run is stopped, their tasks are released, the team directory is archived under ~/.zcode/teams/.archive/, and the single-team slot is released.",
  "",
  "```json",
  "{}",
  "```",
  "",
  "Shutdown is forceful (M1): call team_collect first if you want results from in-flight work.",
].join("\n");

const teamDeleteHandler: ToolHandler = async (input, context) => {
  TeamDeleteInputSchema.parse(input);

  if (!isLeadTeamPort(context.teamPort)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Lead team port is not configured for team_delete",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: TEAM_DELETE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return (await context.teamPort.deleteTeam({})) satisfies TeamDeleteOutput;
};

export const teamDeleteToolEntry: ToolEntry = {
  capability: "Delete the active agent team",
  metadata: {
    name: TEAM_DELETE_TOOL_NAME,
    description: TEAM_DELETE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TEAM_DELETE_MODEL_BYTES,
    sideEffectScope: "system",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: teamDeleteHandler,
  formatModelContent: formatTeamDeleteModelContent,
  inputSchema: TeamDeleteInputJsonSchema,
  outputSchema: TEAM_DELETE_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamDeleteInputSchema,
  runtimeOutputSchema: TeamDeleteOutputSchema,
  permission: {
    permission: "team.delete",
    reason: "team_delete archives and removes the active team directory",
    riskLevel: "medium",
    sideEffectScope: "system",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_DELETE_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_DELETE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TEAM_DELETE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "team_delete was cancelled before the team was archived",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "none",
    recordOutput: "summary",
  },
};

function formatTeamDeleteModelContent(output: unknown): string {
  const result = TeamDeleteOutputSchema.parse(output);
  if (result.status === "success") {
    return `Team ${result.teamName ?? ""} deleted. ${result.message}`;
  }
  return `Team deletion failed: ${result.error ?? result.message}`;
}
