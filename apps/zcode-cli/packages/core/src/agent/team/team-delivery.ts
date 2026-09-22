import type {
  SessionId,
  SubagentSendMessageResult,
  SubagentPort,
  TeamDeliveryTarget,
  TeamDeliveryTargetRef,
} from "@zcode/contracts";

/**
 * 成员消息投递适配器：把路由层的 TeamDeliveryTarget 调用翻译成 lead 侧 subagent 端口的
 * sendMessage（busy→steer，idle→后台复活）。sessionId/cwd 绑定 lead 装配上下文；
 * parentToolCallId 用固定标记——投递可能发生在成员的 turn 里，lead 侧没有对应 tool call 可引。
 * to 必须用 agentId：任务注册表按它索引，成员名在真机端口查不到任务。
 */
export function createSubagentTeamDelivery(
  port: SubagentPort,
  lead: { sessionId: SessionId; workingDirectory: string },
): TeamDeliveryTarget {
  return {
    sendMessage: async (target: TeamDeliveryTargetRef, entry) => {
      if (port.sendMessage === undefined) {
        return unavailable(target.memberName);
      }
      return port.sendMessage({
        sessionId: lead.sessionId,
        parentToolCallId: "team_router",
        to: target.agentId ?? target.memberName,
        summary: entry.summary,
        message: entry.message,
        workingDirectory: lead.workingDirectory,
        workspaceRoot: lead.workingDirectory,
        trace: entry.trace,
      });
    },
  };
}

function unavailable(memberName: string): SubagentSendMessageResult {
  const error = `Teammate '${memberName}' cannot receive messages: subagent port has no sendMessage.`;
  return { status: "failed", messageId: "msg_unavailable", error, message: error };
}
