import { z } from "zod";
import type { TraceContext } from "../tracing/tracer.js";

// ============================================================
// Agent Teams 实体与端口契约（M1）
// ============================================================

/** 团队名即目录名，收窄到文件系统安全的字符集。 */
export const TEAM_NAME_SCHEMA = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/, "1-32 chars: letters, digits, _ or -");

export const LEAD_MEMBER_NAME = "lead";

export const TEAM_MEMBER_STATE_SCHEMA = z.enum([
  "spawning",
  "idle",
  "busy",
  "stopped",
  "failed",
]);
export type TeamMemberState = z.infer<typeof TEAM_MEMBER_STATE_SCHEMA>;

export const TEAM_MEMBER_SCHEMA = z.object({
  name: z.string().min(1).max(32),
  agentId: z.string().min(1),
  profile: z.string().optional(),
  model: z.string().optional(),
  readOnly: z.boolean().optional(),
  maxTurns: z.number().int().positive().optional(),
  state: TEAM_MEMBER_STATE_SCHEMA,
});
export type TeamMember = z.infer<typeof TEAM_MEMBER_SCHEMA>;

/** ~/.zcode/teams/{name}/config.json 的落盘形状。世代号用于防并发误删（qwen 验证设计）。 */
export const TEAM_CONFIG_FILE_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  teamName: z.string().min(1).max(32),
  leadSessionId: z.string().min(1),
  leadPid: z.number().int().positive(),
  members: z.array(TEAM_MEMBER_SCHEMA),
  createdAt: z.string().min(1),
  generation: z.number().int().positive(),
});
export type TeamConfigFile = z.infer<typeof TEAM_CONFIG_FILE_SCHEMA>;

/** inboxes/{member}.json 的落盘形状：M1 是持久化镜像（消费方是进程内事件总线），不是轮询源。 */
export const TEAM_INBOX_FILE_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  messages: z
    .array(
      z.object({
        messageId: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        summary: z.string(),
        message: z.string(),
        queuedAt: z.string().min(1),
      }),
    )
    .max(50),
});
export type TeamInboxFile = z.infer<typeof TEAM_INBOX_FILE_SCHEMA>;

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
  // to 只接受本团队成员名（含 lead），路由层做白名单校验。端口缺席即 team_send 工具不注册，
  // 非团队成员会话不受影响。
  send(to: string, request: TeamSendMessage): TeamSendResult;
}

export interface TeamCreateRequest {
  name: string;
}

export interface TeamCreateResult {
  status: "success" | "failed";
  teamName?: string;
  message: string;
  error?: string;
}

export interface TeamDeleteRequest {
  // 单团队互斥：删除对象恒为当前活跃团队，不需要参数。
}

export interface TeamDeleteResult {
  status: "success" | "failed";
  teamName?: string;
  message: string;
  error?: string;
}

/**
 * lead（主会话）侧端口：在 team_send 之上加团队生命周期操作。
 * bootstrap 在 features.agentTeams 开启时于主会话装配期注入稳定句柄——工具注册是构造期
 * 一次性的，而团队是会话中途建的，句柄必须先于注册在场；无团队时各操作直接返回 failed。
 * 成员（子会话）只拿窄面 TeamPort，永远不满足 isLeadTeamPort。
 */
export interface LeadTeamPort extends TeamPort {
  createTeam(request: TeamCreateRequest): Promise<TeamCreateResult>;
  deleteTeam(request: TeamDeleteRequest): Promise<TeamDeleteResult>;
}

/** 注册门特征检测：成员端口永远不满足（只有 lead 句柄实现生命周期操作）。 */
export function isLeadTeamPort(port: TeamPort | undefined): port is LeadTeamPort {
  return port !== undefined && "createTeam" in port;
}
