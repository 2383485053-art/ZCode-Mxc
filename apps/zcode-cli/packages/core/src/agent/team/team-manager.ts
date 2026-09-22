import { randomUUID } from "node:crypto";
import type {
  LeadTeamPort,
  Logger,
  TeamCreateRequest,
  TeamCreateResult,
  TeamDeleteRequest,
  TeamDeleteResult,
  TeamPort,
  TeamSendResult,
  TeamSendMessage,
} from "@zcode/contracts";
import { isPidAlive, TeamStore, TeamStoreError } from "./team-store.js";

/**
 * TeamManager（M1 实体层）：团队生命周期 + 进程内路由。
 * 挂在 lead 的 app 装配里，随主会话存续；跨进程互斥由磁盘上的 leadPid 活性判定兜底。
 *
 * 本 PR（实体层）的边界：尚无成员 spawn/投递唤醒——route 只写持久化镜像并返回 queued，
 * 事件总线消费方随通信层 PR 接上；team_delete 尚无关机握手（断言成员为空）。
 */
export class TeamManager {
  private active: { name: string; generation: number } | undefined;

  constructor(
    private readonly store: TeamStore,
    private readonly leadSessionId: string,
    private readonly logger?: Logger,
  ) {}

  get activeTeam(): { name: string; generation: number } | undefined {
    return this.active;
  }

  async createTeam(request: TeamCreateRequest): Promise<TeamCreateResult> {
    if (this.active) {
      return failed(`Team '${this.active.name}' is already active. Delete it before creating another.`);
    }
    try {
      // 单团队互斥的跨进程半边：清扫 stale 团队（lead 已死→归档回收），活着的一律拒绝。
      for (const name of await this.store.listTeamNames()) {
        const config = await this.readConfigOrSweep(name);
        if (!config) continue;
        if (isPidAlive(config.leadPid)) {
          return failed(
            `Team '${name}' is active in another session (pid ${config.leadPid}). Delete it there first.`,
          );
        }
        await this.store.archiveTeam(name);
        this.logger?.info?.("Archived stale team during createTeam", {
          module: "core.agent.team",
          staleTeam: name,
          stalePid: config.leadPid,
        });
      }
      const config = {
        schemaVersion: 1 as const,
        teamName: request.name,
        leadSessionId: this.leadSessionId,
        leadPid: process.pid,
        members: [],
        createdAt: new Date().toISOString(),
        generation: 1,
      };
      await this.store.createTeamDir(request.name, config);
      this.active = { name: request.name, generation: config.generation };
      this.logger?.info?.("Team created", { module: "core.agent.team", team: request.name });
      return {
        status: "success",
        teamName: request.name,
        message: `Team '${request.name}' created. You are the lead; spawn teammates to begin.`,
      };
    } catch (error) {
      return failed(`Team creation failed: ${errorMessage(error)}`, request.name);
    }
  }

  async deleteTeam(_request: TeamDeleteRequest): Promise<TeamDeleteResult> {
    if (!this.active) {
      return failed("No active team to delete.");
    }
    const { name } = this.active;
    try {
      const config = await this.store.readConfig(name);
      // 世代号防并发误删（设计 2.3）：磁盘世代必须与内存一致，否则可能有第二个管理者动过。
      if (config.generation !== this.active.generation) {
        return failed(
          `Team '${name}' generation changed on disk (${config.generation} vs ${this.active.generation}); refusing to delete.`,
          name,
        );
      }
      if (config.members.length > 0) {
        // 关机握手随通信层 PR 落地；实体层阶段不可能有成员，出现即状态异常，拒绝删除。
        return failed(
          `Team '${name}' still has ${config.members.length} member(s); shutdown handshake is not implemented yet.`,
          name,
        );
      }
      await this.store.archiveTeam(name);
      this.active = undefined;
      this.logger?.info?.("Team deleted", { module: "core.agent.team", team: name });
      return { status: "success", teamName: name, message: `Team '${name}' archived and deleted.` };
    } catch (error) {
      return failed(`Team deletion failed: ${errorMessage(error)}`, name);
    }
  }

  /**
   * 路由（实体层部分）：白名单校验 + 持久化镜像 + queued 应答。
   * 每条消息必有明确结局（送达/入队/拒绝，设计 2.4）——本层负责「入队」与「拒绝」，
   * 「送达」（steer/复活唤醒）随通信层 PR 接在镜像写入之后。
   */
  route(from: string, to: string, request: TeamSendMessage): TeamSendResult {
    const messageId = `teammsg_${randomUUID()}`;
    if (!this.active) {
      return {
        status: "failed",
        messageId,
        message: "Message was not delivered.",
        error: "No active team. Create a team first with team_create.",
      };
    }
    if (to === from) {
      return {
        status: "failed",
        messageId,
        message: "Message was not delivered.",
        error: "Cannot send a team message to yourself.",
      };
    }
    // 成员 roster 校验随 spawn PR 接入；当前唯一合法收件人是 lead。
    if (to !== "lead") {
      return unknownTeammate(messageId, to);
    }
    const entry = {
      messageId,
      from,
      to,
      summary: request.summary,
      message: request.message,
      queuedAt: new Date().toISOString(),
    };
    // 镜像写入是 async 的，但端口契约是同步应答（同 CoordinatorResponsePort 的入队 ack 纪律）。
    // fire-and-forget + 失败日志：queued 的语义由内存态保证，镜像丢失不回滚应答。
    void this.store
      .appendInboxMessage(this.active.name, to, entry)
      .catch((error: unknown) => {
        this.logger?.warn?.("Team inbox mirror write failed", {
          module: "core.agent.team",
          team: this.active?.name,
          messageId,
          error: errorMessage(error),
        });
      });
    return {
      status: "success",
      messageId,
      message: `Message queued for ${to}.`,
    };
  }

  private async readConfigOrSweep(name: string) {
    try {
      return await this.store.readConfig(name);
    } catch (error) {
      if (error instanceof TeamStoreError && error.code === "not_found") {
        return undefined;
      }
      throw error;
    }
  }
}

/**
 * lead 稳定句柄（四审 P1 方案 a）：装配期注入、先于工具注册在场；
 * 无团队时各操作快速失败。from 身份由闭包绑定，模型不可谎报。
 */
export function createLeadTeamPort(manager: TeamManager): LeadTeamPort {
  return {
    send: (to, request) => manager.route("lead", to, request),
    createTeam: (request) => manager.createTeam(request),
    deleteTeam: (request) => manager.deleteTeam(request),
  };
}

/** 成员窄面端口（spawn PR 用）：identity 同样闭包绑定。 */
export function createMemberTeamPort(manager: TeamManager, memberName: string): TeamPort {
  return {
    send: (to, request) => manager.route(memberName, to, request),
  };
}

function failed(reason: string, teamName?: string): TeamCreateResult & TeamDeleteResult {
  // 失败原因同时进 error（与 route() 的失败语义一致，供程序化判别）与 message（人读）。
  return { status: "failed", ...(teamName ? { teamName } : {}), message: reason, error: reason };
}

function unknownTeammate(messageId: string, to: string): TeamSendResult {
  return {
    status: "failed",
    messageId,
    message: "Message was not delivered.",
    error: `Unknown teammate '${to}'. Teammate spawn arrives with the communication layer; the only valid recipient today is 'lead'.`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
