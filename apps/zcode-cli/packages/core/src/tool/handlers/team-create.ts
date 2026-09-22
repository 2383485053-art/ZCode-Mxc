import {
  CoreErrorType,
  TEAM_CREATE_TOOL_NAME,
  TeamCreateInputJsonSchema,
  TeamCreateInputSchema,
  TeamCreateOutputSchema,
  isLeadTeamPort,
  createCoreError,
  type TeamCreateInput,
  type TeamCreateOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TEAM_CREATE_MODEL_BYTES = 4_096;

const TEAM_CREATE_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TEAM_CREATE_PROVIDER_DESCRIPTION = [
  "# team_create",
  "",
  "Create an agent team with yourself as the lead.",
  "",
  "```json",
  '{"name": "refactor-auth"}',
  "```",
  "",
  "Only one team can be active at a time. After creating a team you can message the team and (once teammates are spawned) coordinate work across members.",
].join("\n");

const teamCreateHandler: ToolHandler = async (input, context) => {
  const parsed = TeamCreateInputSchema.parse(input) as TeamCreateInput;

  if (!isLeadTeamPort(context.teamPort)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Lead team port is not configured for team_create",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: TEAM_CREATE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return (await context.teamPort.createTeam({
    name: parsed.name,
  })) satisfies TeamCreateOutput;
};

export const teamCreateToolEntry: ToolEntry = {
  capability: "Create an agent team led by this session",
  metadata: {
    name: TEAM_CREATE_TOOL_NAME,
    description: TEAM_CREATE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TEAM_CREATE_MODEL_BYTES,
    sideEffectScope: "system",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: teamCreateHandler,
  formatModelContent: formatTeamCreateModelContent,
  inputSchema: TeamCreateInputJsonSchema,
  outputSchema: TEAM_CREATE_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamCreateInputSchema,
  runtimeOutputSchema: TeamCreateOutputSchema,
  permission: {
    permission: "team.create",
    reason: "team_create writes a team directory under ~/.zcode/teams",
    riskLevel: "low",
    sideEffectScope: "system",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_CREATE_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_CREATE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TEAM_CREATE_MODEL_BYTES,
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
    userVisibleMessage: "team_create was cancelled before the team directory was finalized",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTeamCreateModelContent(output: unknown): string {
  const result = TeamCreateOutputSchema.parse(output);
  if (result.status === "success") {
    return `Team ${result.teamName ?? ""} created. ${result.message}`;
  }
  return `Team creation failed: ${result.error ?? result.message}`;
}
