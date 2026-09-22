import {
  CoreErrorType,
  TEAM_ADOPT_TOOL_NAME,
  TeamAdoptInputJsonSchema,
  TeamAdoptInputSchema,
  TeamAdoptOutputSchema,
  createCoreError,
  isLeadTeamPort,
  type TeamAdoptInput,
  type TeamAdoptOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TEAM_ADOPT_MODEL_BYTES = 4_096;

const TEAM_ADOPT_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    team_name: { type: "string" },
    generation: { type: "number" },
    adopted_members: { type: "number" },
    released_tasks: { type: "number" },
    pending_messages: { type: "number" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TEAM_ADOPT_PROVIDER_DESCRIPTION = [
  "# team_adopt",
  "",
  "Adopt an orphaned team whose lead session died: keep the board and inboxes, mark members dead, and become the new lead. Lead only.",
  "",
  "```json",
  '{"name": "app-refactor"}',
  "```",
  "",
  "Use it after a crash or a killed session to continue where the old lead stopped: their in-progress tasks are released back to the board, undelivered messages are preserved (yours are injected into your next turn; teammates' replay on revival). Revive a dead teammate with team_spawn_teammate using their original name — their worktree branch is re-attached. Refused while the recorded lead pid is still alive.",
].join("\n");

const teamAdoptHandler: ToolHandler = async (input, context) => {
  const parsed = TeamAdoptInputSchema.parse(input) as TeamAdoptInput;

  if (!isLeadTeamPort(context.teamPort)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Lead team port is not configured for team_adopt",
      {
        context: { toolCallId: context.toolCallId, toolName: TEAM_ADOPT_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const result = await context.teamPort.adoptTeam({ name: parsed.name });
  return {
    status: result.status,
    ...(result.teamName !== undefined ? { team_name: result.teamName } : {}),
    ...(result.generation !== undefined ? { generation: result.generation } : {}),
    ...(result.adoptedMembers !== undefined ? { adopted_members: result.adoptedMembers } : {}),
    ...(result.releasedTasks !== undefined ? { released_tasks: result.releasedTasks } : {}),
    ...(result.pendingMessages !== undefined
      ? { pending_messages: result.pendingMessages }
      : {}),
    message: result.message,
    ...(result.error !== undefined ? { error: result.error } : {}),
  } satisfies TeamAdoptOutput;
};

export const teamAdoptToolEntry: ToolEntry = {
  capability: "Adopt an orphaned team whose lead died",
  metadata: {
    name: TEAM_ADOPT_TOOL_NAME,
    description: TEAM_ADOPT_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TEAM_ADOPT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: teamAdoptHandler,
  formatModelContent: formatTeamAdoptModelContent,
  inputSchema: TeamAdoptInputJsonSchema,
  outputSchema: TEAM_ADOPT_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamAdoptInputSchema,
  runtimeOutputSchema: TeamAdoptOutputSchema,
  permission: {
    permission: "team.adopt",
    reason: "team_adopt takes over an orphaned team directory as the new lead",
    riskLevel: "medium",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_ADOPT_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_ADOPT_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TEAM_ADOPT_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 30_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "team_adopt was cancelled before the takeover completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTeamAdoptModelContent(output: unknown): string {
  const result = TeamAdoptOutputSchema.parse(output);
  return result.message;
}
