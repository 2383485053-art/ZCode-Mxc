import type { TraceContext } from "../tracing/tracer.js";

export interface TeamSendMessage {
  summary: string;
  message: string;
  trace: TraceContext;
}

export interface TeamSendResult {
  status: "success" | "failed";
  messageId: string;
  message: string;
  error?: string;
}

export interface TeamPort {
  // 发送方身份由 port closure 绑定（同 CoordinatorResponsePort 纪律），模型不能谎报 from。
  // to 只接受本团队成员名，路由层做白名单校验。端口缺席即 team_send 工具不注册，
  // 非团队成员会话不受影响。
  send(to: string, request: TeamSendMessage): TeamSendResult;
}
