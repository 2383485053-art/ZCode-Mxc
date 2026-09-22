import { randomUUID } from "node:crypto";
import type {
  LeadTeamPort,
  Logger,
  TeamCreateRequest,
  TeamCreateResult,
  TeamDeleteRequest,
  TeamDeleteResult,
  TeamMember,
  TeamMemberRegistration,
  TeamPort,
  TeamRosterResult,
  TeamSendResult,
  TeamSendMessage,
} from "@zcode/contracts";
import { isPidAlive, TeamStore, TeamStoreError } from "./team-store.js";

/** 成员默认上限（设计 2.3 的 3-5 甜点）；settings 键 team.maxTeammates 随治理层 PR 接入。 */
const DEFAULT_MAX_TEAMMATES = 5;

/**
 * TeamManager（M1 实体层 + roster）：团队生命周期、成员名册、进程内路由。
 * 挂在 lead 的 app 装配里，随主会话存续；跨进程互斥由磁盘上的 leadPid 活性判定兜底。
 *
 * 本 PR 的边界：投递唤醒（steer/复活）随通信层下半场——route 校验白名单并写持久化镜像，
 * 返回 queued；team_delete 尚无关机握手（roster 非空即拒绝）。
 */
export class TeamManager {
  private active: { name: string; generation: number } | undefined;
  private roster: TeamMember[] = [];

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
      this.roster = [];
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
      if (config.members.length > 0 || this.roster.length > 0) {
        // 关机握手随通信层下半场；此前 roster 非空一律拒绝删除。
        return failed(
          `Team '${name}' still has ${Math.max(config.members.length, this.roster.length)} member(s); remove them (or wait for the shutdown handshake) before deleting.`,
          name,
        );
      }
      await this.store.archiveTeam(name);
      this.active = undefined;
      this.roster = [];
      this.logger?.info?.("Team deleted", { module: "core.agent.team", team: name });
      return { status: "success", teamName: name, message: `Team '${name}' archived and deleted.` };
    } catch (error) {
      return failed(`Team deletion failed: ${errorMessage(error)}`, name);
    }
  }

  async reserveMember(registration: TeamMemberRegistration): Promise<TeamRosterResult> {
    if (!this.active) {
      return rosterFailed("No active team. Create a team first with team_create.");
    }
    if (registration.name === "lead") {
      return rosterFailed("'lead' is reserved for the lead; pick another teammate name.");
    }
    if (this.roster.some((member) => member.name === registration.name)) {
      return rosterFailed(`Teammate '${registration.name}' already exists.`);
    }
    if (this.roster.length >= DEFAULT_MAX_TEAMMATES) {
      return rosterFailed(
        `Team is full (${DEFAULT_MAX_TEAMMATES} teammates). Finish work before spawning more.`,
      );
    }
    this.roster.push({
      name: registration.name,
      ...(registration.profile ? { profile: registration.profile } : {}),
      ...(registration.readOnly !== undefined ? { readOnly: registration.readOnly } : {}),
      ...(registration.maxTurns !== undefined ? { maxTurns: registration.maxTurns } : {}),
      state: "spawning",
    });
    const persistError = await this.persistRoster();
    if (persistError) {
      this.roster = this.roster.filter((member) => member.name !== registration.name);
      return rosterFailed(`Teammate reservation could not be persisted: ${persistError}`);
    }
    return {
      status: "success",
      teamName: this.active.name,
      memberName: registration.name,
      roster: [...this.roster],
      message: `Teammate '${registration.name}' reserved.`,
    };
  }

  async completeMemberSpawn(
    memberName: string,
    agent: { agentId: string },
  ): Promise<TeamRosterResult> {
    const member = this.roster.find((entry) => entry.name === memberName);
    if (!member || !this.active) {
      return rosterFailed(`Teammate '${memberName}' is not reserved.`);
    }
    member.agentId = agent.agentId;
    member.state = "idle";
    const persistError = await this.persistRoster();
    if (persistError) {
      return rosterFailed(`Teammate spawn could not be persisted: ${persistError}`, memberName);
    }
    return {
      status: "success",
      teamName: this.active.name,
      memberName,
      agentId: agent.agentId,
      roster: [...this.roster],
      message: `Teammate '${memberName}' spawned (agent ${agent.agentId}).`,
    };
  }

  async removeMember(memberName: string, reason?: string): Promise<TeamRosterResult> {
    const member = this.roster.find((entry) => entry.name === memberName);
    if (!member || !this.active) {
      return rosterFailed(`Teammate '${memberName}' is not on the roster.`);
    }
    this.roster = this.roster.filter((entry) => entry.name !== memberName);
    const persistError = await this.persistRoster();
    if (persistError) {
      // 回滚失败意味着磁盘与内存名册分叉——把成员放回去并如实报错，交上层决策。
      this.roster.push(member);
      return rosterFailed(`Teammate removal could not be persisted: ${persistError}`, memberName);
    }
    return {
      status: "success",
      teamName: this.active.name,
      memberName,
      roster: [...this.roster],
      message: reason
        ? `Teammate '${memberName}' removed: ${reason}`
        : `Teammate '${memberName}' removed.`,
    };
  }

  /**
   * 路由（实体层部分）：roster 白名单校验 + 持久化镜像 + queued 应答。
   * 每条消息必有明确结局（送达/入队/拒绝，设计 2.4）——本层负责「入队」与「拒绝」，
   * 「送达」（steer/复活唤醒）随通信层下半场接在镜像写入之后。
   * peer 点对点投递自动向 lead 信箱写一行摘要（cc-lead，设计 2.4：lead 对网状对话保持可见）。
   */
  route(from: string, to: string, request: TeamSendMessage): TeamSendResult {
    const messageId = `teammsg_${randomUUID()}`;
    if (!this.active) {
      return sendFailed(messageId, "No active team. Create a team first with team_create.");
    }
    if (to === from) {
      return sendFailed(messageId, "Cannot send a team message to yourself.");
    }
    const toMember = to === "lead" ? undefined : this.roster.find((member) => member.name === to);
    if (to !== "lead" && !toMember) {
      return sendFailed(
        messageId,
        `Unknown teammate '${to}'. Current roster: lead${this.roster.map((m) => `, ${m.name}`).join("")}.`,
      );
    }
    if (toMember?.state === "spawning") {
      return sendFailed(messageId, `Teammate '${to}' is still spawning; retry shortly.`);
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
    void this.mirrorAppend(to, entry);
    if (from !== "lead" && to !== "lead") {
      void this.mirrorAppend("lead", {
        ...entry,
        messageId: `${messageId}_cc`,
        summary: `[cc-lead] ${from} → ${to}: ${request.summary}`,
        message: `${from} sent to ${to}: ${request.message}`,
      });
    }
    return { status: "success", messageId, message: `Message queued for ${to}.` };
  }

  private async mirrorAppend(
    to: string,
    entry: Parameters<TeamStore["appendInboxMessage"]>[2],
  ): Promise<void> {
    if (!this.active) return;
    try {
      await this.store.appendInboxMessage(this.active.name, to, entry);
    } catch (error) {
      this.logger?.warn?.("Team inbox mirror write failed", {
        module: "core.agent.team",
        team: this.active.name,
        messageId: entry.messageId,
        error: errorMessage(error),
      });
    }
  }

  private async persistRoster(): Promise<string | undefined> {
    if (!this.active) return "no active team";
    try {
      const config = await this.store.readConfig(this.active.name);
      await this.store.writeConfig(this.active.name, { ...config, members: this.roster });
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
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
    reserveMember: (registration) => manager.reserveMember(registration),
    completeMemberSpawn: (memberName, agent) => manager.completeMemberSpawn(memberName, agent),
    removeMember: (memberName, reason) => manager.removeMember(memberName, reason),
    createMemberPort: (memberName) => createMemberTeamPort(manager, memberName),
  };
}

/** 成员窄面端口（注入缝用）：identity 同样闭包绑定。 */
export function createMemberTeamPort(manager: TeamManager, memberName: string): TeamPort {
  return {
    send: (to, request) => manager.route(memberName, to, request),
  };
}

function failed(reason: string, teamName?: string): TeamCreateResult & TeamDeleteResult {
  // 失败原因同时进 error（与 route() 的失败语义一致，供程序化判别）与 message（人读）。
  return { status: "failed", ...(teamName ? { teamName } : {}), message: reason, error: reason };
}

function rosterFailed(reason: string, memberName?: string): TeamRosterResult {
  return {
    status: "failed",
    ...(memberName ? { memberName } : {}),
    message: reason,
    error: reason,
  };
}

function sendFailed(messageId: string, reason: string): TeamSendResult {
  return { status: "failed", messageId, message: "Message was not delivered.", error: reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
