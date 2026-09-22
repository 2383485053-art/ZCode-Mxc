import {
  CoreErrorType,
  TEAM_SEND_TOOL_NAME,
  TeamSendInputJsonSchema,
  TeamSendInputSchema,
  TeamSendOutputSchema,
  createCoreError,
  type TeamSendInput,
  type TeamSendOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { assertNotOffPeakTurn } from "./off-peak.js";

const MAX_TEAM_SEND_MODEL_BYTES = 4_096;

const TEAM_SEND_OFF_PEAK_HINT =
  "Send team messages from a regular turn, not an idle-time task: waking an idle teammate starts a billed run.";

const TEAM_SEND_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    delivery: { type: "string", enum: ["queued", "steered", "resumed_background"] },
    failed_recipients: { type: "array", items: { type: "string" } },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const TEAM_SEND_PROVIDER_DESCRIPTION = [
  "# team_send",
  "",
  "Send a message to a named teammate within the current team, or broadcast with \"*\".",
  "",
  "```json",
  '{"to": "reviewer", "summary": "api draft ready", "message": "contracts/team.port.ts is finalized; start your review."}',
  "```",
  "",
  "Use teammate names as they appear in your team briefing; \"*\" delivers to everyone (lead included, yourself excluded) and reports failed_recipients for anyone who could not receive it. Messages are delivered by the team router; you do not check an inbox. Continue your current task unless the message changes or ends it.",
].join("\n");

const teamSendHandler: ToolHandler = async (input, context) => {
  const parsed = TeamSendInputSchema.parse(input) as TeamSendInput;

  // 投递可能唤醒空闲成员（后台复活 = 新的计费 run），与 team_spawn_teammate 同一纪律。
  assertNotOffPeakTurn(context, TEAM_SEND_TOOL_NAME, {
    hint: TEAM_SEND_OFF_PEAK_HINT,
    recoverable: true,
  });

  if (!context.teamPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Team port is not configured for team_send",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: TEAM_SEND_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const result = await context.teamPort.send(parsed.to, {
    summary: parsed.summary,
    message: parsed.message,
    trace: resolveToolTraceContext(context),
  });
  // 工具面字段是 snake_case（failedRecipients → failed_recipients），端口结果整体翻译。
  return {
    status: result.status,
    messageId: result.messageId,
    message: result.message,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.delivery !== undefined ? { delivery: result.delivery } : {}),
    ...(result.failedRecipients !== undefined
      ? { failed_recipients: result.failedRecipients }
      : {}),
  } satisfies TeamSendOutput;
};

export const teamSendToolEntry: ToolEntry = {
  capability: "Send a short message to a named teammate",
  metadata: {
    name: TEAM_SEND_TOOL_NAME,
    description: TEAM_SEND_PROVIDER_DESCRIPTION,
    // plan 模式的团队成员仍须能互发消息（同 RespondToCoordinator 的理由：plan 期协调不能断）。
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TEAM_SEND_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: teamSendHandler,
  formatModelContent: formatTeamSendModelContent,
  inputSchema: TeamSendInputJsonSchema,
  outputSchema: TEAM_SEND_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamSendInputSchema,
  runtimeOutputSchema: TeamSendOutputSchema,
  permission: {
    permission: "team.message.send",
    reason: "team_send writes a message to a teammate queue",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_SEND_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_SEND_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TEAM_SEND_MODEL_BYTES,
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
    userVisibleMessage: "team_send was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTeamSendModelContent(output: unknown): string {
  const result = TeamSendOutputSchema.parse(output);
  const continuation = "Continue the current task unless the teammate explicitly changed or ended it.";
  if (result.status === "success") {
    // delivery 枚举词明示进文本（真机验收遗留③：结构化值要进模型可见面）。
    const outcome =
      result.delivery === "resumed_background"
        ? "delivery: resumed_background — the teammate was idle and was resumed in the background with your message."
        : result.delivery === "steered"
          ? "delivery: steered — the message was delivered into the teammate's active turn."
          : result.delivery === "queued"
            ? "delivery: queued — the message was queued for the recipient."
            : result.message;
    const broadcastNote =
      result.failed_recipients !== undefined && result.failed_recipients.length > 0
        ? ` Broadcast partially failed: ${result.failed_recipients.join(", ")}.`
        : "";
    return `${outcome}${broadcastNote} ${continuation}`;
  }
  const failedList =
    result.failed_recipients !== undefined && result.failed_recipients.length > 0
      ? ` Failed recipients: ${result.failed_recipients.join(", ")}.`
      : "";
  return `Message ${result.messageId} failed to send.${failedList} ${continuation} Failure: ${result.error ?? result.message}.`;
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
