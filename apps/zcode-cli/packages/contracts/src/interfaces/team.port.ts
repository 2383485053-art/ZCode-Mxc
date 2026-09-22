import { z } from "zod";
import type { SubagentSendMessageResult } from "./subagent.port.js";
import type { TraceContext } from "../tracing/tracer.js";

// ============================================================
// Agent Teams 实体与端口契约（M1）
// ============================================================

/** 团队名即目录名，收窄到文件系统安全的字符集。 */
export const TEAM_NAME_SCHEMA = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/, "1-32 chars: letters, digits, _ or -");

export const LEAD_MEMBER_NAME = "lead";

/** 团队成员每轮 turn 预算默认（红旗 1：子代理默认 4 轮远不够团队协作；profile 可覆盖）。 */
export const TEAMMATE_DEFAULT_MAX_TURNS = 20;

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
  // 后台 spawn 的返回里才有 agentId;spawning 态（已占名额未起跑）尚无。
  agentId: z.string().min(1).optional(),
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

// ============================================================
// 共享看板（设计 2.5）
// ============================================================

export const TEAM_TASK_STATUS_SCHEMA = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
export type TeamTaskStatus = z.infer<typeof TEAM_TASK_STATUS_SCHEMA>;

/**
 * 看板任务。blocks 不落盘（blockedBy 的反向投影，读取时派生）——双写必漂移。
 * worklog 相对 ~/.zcode/teams/{name}/（成员 O3 的落笔处，M1 只建引用不建文件）。
 */
export const TEAM_TASK_SCHEMA = z.object({
  id: z.string().min(1),
  subject: z.string().min(1).max(500),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  status: TEAM_TASK_STATUS_SCHEMA,
  blockedBy: z.array(z.string().min(1)),
  owner: z.string().optional(),
  sharedContext: z.array(z.string()).optional(),
  worklog: z.string().optional(),
  blocks: z.array(z.string().min(1)).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type TeamTask = z.infer<typeof TEAM_TASK_SCHEMA>;

/** tasks/board.json 的落盘形状。nextId 即水位（.highwatermark 的进程内等价物，M1 单写者）。 */
export const TEAM_BOARD_FILE_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  nextId: z.number().int().positive(),
  tasks: z.array(TEAM_TASK_SCHEMA),
});
export type TeamBoardFile = z.infer<typeof TEAM_BOARD_FILE_SCHEMA>;

export interface TeamTaskCreateRequest {
  subject: string;
  description?: string;
  activeForm?: string;
  blockedBy?: string[];
  sharedContext?: string[];
}

export interface TeamTaskCreateResult {
  status: "success" | "failed";
  taskId?: string;
  task?: TeamTask;
  message: string;
  error?: string;
}

export interface TeamTaskListResult {
  status: "success" | "failed";
  teamName?: string;
  tasks: TeamTask[];
  message: string;
  error?: string;
}

export interface TeamTaskQueryRequest {
  taskId: string;
}

export interface TeamTaskQueryResult {
  status: "success" | "failed";
  task?: TeamTask;
  message: string;
  error?: string;
}

/** status/owner 变更；completed/cancelled 为终态不可再改。 */
export interface TeamTaskUpdateRequest {
  taskId: string;
  status?: TeamTaskStatus;
  owner?: string;
}

export interface TeamTaskUpdateResult {
  status: "success" | "failed";
  task?: TeamTask;
  message: string;
  error?: string;
}

/**
 * 合流（设计 2.5）：等调用时刻的非终态任务到达终态。requireAll=true（默认）等全部；
 * false 任一到达即返回。超时返回部分结果——status: completed | partial | timeout。
 */
export interface TeamCollectRequest {
  timeoutMs?: number;
  requireAll?: boolean;
}

export interface TeamCollectResult {
  status: "completed" | "partial" | "timeout" | "failed";
  tasks: TeamTask[];
  message: string;
  error?: string;
}

export interface TeamSendMessage {
  summary: string;
  message: string;
  trace: TraceContext;
}

/**
 * 消息结局（设计 2.4：每条消息必有明确结局）。queued = 仅入队（收件人是 lead，
 * 或成员任务不在场由注册表排队）；steered = 已注入收件成员的活跃 turn；
 * resumed_background = 成员空闲，已带消息后台复活。
 */
export type TeamDeliveryState = "queued" | "steered" | "resumed_background";

export interface TeamSendResult {
  status: "success" | "failed";
  messageId: string;
  message: string;
  error?: string;
  delivery?: TeamDeliveryState;
}

/**
 * 投递目标引用：memberName 供镜像/报错使用；agentId 是 lead 进程子代理任务注册表的
 * 键——真机 sendMessage 按它查任务，缺席只能如实失败。
 */
export interface TeamDeliveryTargetRef {
  memberName: string;
  agentId?: string;
}

/**
 * 投递钩子（通信层下半场）：把已过白名单校验的成员消息送进 lead 进程的子代理任务
 * 注册表（busy→steer，idle→后台复活）。由装配层（bootstrap）铸造成员适配器后挂在
 * TeamManager 上；lead 收件人不走此钩子（主会话无任务可 steer，恒 queued）。
 */
export interface TeamDeliveryTarget {
  sendMessage(
    target: TeamDeliveryTargetRef,
    entry: { summary: string; message: string; trace: TraceContext },
  ): Promise<SubagentSendMessageResult>;
}

/**
 * 成员控制钩子（治理层）：停成员任务（关机）与探测成员任务状态（僵尸清扫）。
 * 同投递钩子一样由装配层回填；缺席时关机退化为跳过停止、清扫退化为跳过。
 */
export interface TeamMemberControlTarget {
  stopAgent(agentId: string): Promise<void>;
  /** running=活跃 run；succeeded/failed=终态；missing=任务不在注册表。 */
  getAgentStatus(agentId: string): Promise<"running" | "succeeded" | "failed" | "missing">;
}

export interface TeamPort {
  // 发送方身份由 port closure 绑定（同 CoordinatorResponsePort 纪律），模型不能谎报 from。
  // to 只接受本团队成员名（含 lead），路由层做白名单校验。端口缺席即 team_send 工具不注册，
  // 非团队成员会话不受影响。
  // 异步契约：成员收件要等 steer/复活的实际结局才能应答（设计 2.4「明确结局」）。
  send(to: string, request: TeamSendMessage): Promise<TeamSendResult>;
  // 看板读取/更新（设计 2.5 ACL）：任何团队成员都可读；updateTask 的调用者身份闭包绑定，
  // 成员只能动自己的任务（认领/完成/归还），lead 不受限。
  listTasks(): Promise<TeamTaskListResult>;
  queryTask(request: TeamTaskQueryRequest): Promise<TeamTaskQueryResult>;
  updateTask(request: TeamTaskUpdateRequest): Promise<TeamTaskUpdateResult>;
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
export interface TeamMemberRegistration {
  name: string;
  profile?: string;
  readOnly?: boolean;
  maxTurns?: number;
}

export interface TeamRosterResult {
  status: "success" | "failed";
  teamName?: string;
  memberName?: string;
  agentId?: string;
  roster?: TeamMember[];
  message: string;
  error?: string;
}

export interface LeadTeamPort extends TeamPort {
  createTeam(request: TeamCreateRequest): Promise<TeamCreateResult>;
  deleteTeam(request: TeamDeleteRequest): Promise<TeamDeleteResult>;
  /** 占位并落盘（state=spawning）；失败（无团队/重名/超上限）不占名额。 */
  reserveMember(registration: TeamMemberRegistration): Promise<TeamRosterResult>;
  /** spawn 成功回填 agentId，state→idle。 */
  completeMemberSpawn(memberName: string, agent: { agentId: string }): Promise<TeamRosterResult>;
  /** spawn 失败/成员移除：回滚 roster 条目并落盘。 */
  removeMember(memberName: string, reason?: string): Promise<TeamRosterResult>;
  /**
   * 给团队成员铸窄面端口（注入缝用）：send 的 from 闭包绑定为该成员名。
   * 只有 lead 句柄实现——成员端口永远不满足 isLeadTeamPort。
   */
  createMemberPort(memberName: string): TeamPort;
  /** 建任务（ACL：仅 lead；成员经 updateTask 认领）。 */
  createTask(request: TeamTaskCreateRequest): Promise<TeamTaskCreateResult>;
  /** 合流等待（ACL：仅 lead；等非终态任务到达终态，超时带部分结果）。 */
  collectTasks(request: TeamCollectRequest, signal?: AbortSignal): Promise<TeamCollectResult>;
}

/** 注册门特征检测：成员端口永远不满足（只有 lead 句柄实现生命周期操作）。 */
export function isLeadTeamPort(port: TeamPort | undefined): port is LeadTeamPort {
  return port !== undefined && "createTeam" in port;
}
