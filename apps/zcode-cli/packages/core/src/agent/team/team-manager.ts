/* eslint-disable max-lines -- TeamManager 集中承载团队生命周期/名册/投递路由/看板状态机与 ACL，
   单 writer 单进程的 M1 边界先在这里稳定（roster/看板/投递共享同一份内存真相与落盘节奏），
   M2/M3 引入跨进程与 hooks 时再按职责拆分。 */
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  LeadTeamPort,
  Logger,
  TeamAdoptRequest,
  TeamAdoptResult,
  TeamCollectRequest,
  TeamCollectResult,
  TeamCreateRequest,
  TeamCreateResult,
  TeamDeleteRequest,
  TeamDeleteResult,
  TeamDeliveryTarget,
  TeamHookTarget,
  TeamHookNotification,
  TeamInboxFile,
  TeamLeadInboxTarget,
  TeamMergeRejection,
  TeamMergeRequest,
  TeamMergeResult,
  TeamMember,
  TeamMemberControlTarget,
  TeamMemberRegistration,
  TeamMemberWorkspaceResult,
  TeamMemberWritePolicy,
  TeamPendingMessage,
  TeamPort,
  TeamRosterResult,
  TeamSendResult,
  TeamSendMessage,
  TeamTask,
  TeamTaskCreateRequest,
  TeamTaskCreateResult,
  TeamTaskListResult,
  TeamTaskQueryRequest,
  TeamTaskQueryResult,
  TeamTaskUpdateRequest,
  TeamTaskUpdateResult,
} from "@zcode/contracts";
import {
  TEAM_COLLECT_DEFAULT_TIMEOUT_MS,
  TEAM_COLLECT_MAX_TIMEOUT_MS,
  TEAM_COLLECT_MIN_TIMEOUT_MS,
} from "@zcode/contracts";
import { attachWorktree, commitAll, createWorktree, diffFiles, isCheckoutDirty, isGitRepository, isWorktreeDirty, mergeBaseOf, mergeBranch, removeWorktree, runGit } from "./team-git.js";
import { matchesAnyScope } from "./team-write-policy.js";
import { isPidAlive, TeamStore, TeamStoreError } from "./team-store.js";

/** 成员默认上限（设计 2.3 的 3-5 甜点）；settings 键 team.maxTeammates 随治理层 PR 接入。 */
const DEFAULT_MAX_TEAMMATES = 5;

const COLLECT_POLL_INTERVAL_MS = 500;

/** M3 细粒度配额（设计 2.4，grok 验证设计 4/32/32KiB）：单条消息上限、单对在途上限、
 * 单信箱在途容量上限。在途 = 信箱里无 deliveredAt 的条目；拒绝发生在写入之前。 */
const TEAM_MESSAGE_MAX_BYTES = 32 * 1024;
const TEAM_PAIR_INFLIGHT_MAX = 4;
const TEAM_INBOX_INFLIGHT_MAX = 32;
/** M3 文件信箱轮询后端周期（设计 2.4：lead 信箱注入 + run 级 TeammateIdle 检测）。 */
const TEAM_INBOX_POLL_INTERVAL_MS = 500;

/** 终态判定：completed/cancelled 之后看板条目不可再改（设计 2.5）。 */
function isTaskTerminal(status: TeamTask["status"]): boolean {
  return status === "completed" || status === "cancelled";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * scope 相交判定的保守近似：glob 截到首个通配段得路径前缀（src/auth/** →
 * src/auth），前缀相等或互为目录祖先即视为重叠。docs/*.md vs docs/*.txt 会被
 * 误报相交——宁可误报（lead 调整 scope）不可漏报（并行 writer 互相踩）。
 */
function scopesOverlap(a: string, b: string): boolean {
  const pa = scopePrefix(a);
  const pb = scopePrefix(b);
  if (pa === "" || pb === "") return true;
  return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

function scopePrefix(glob: string): string {
  const idx = glob.search(/[*?]/);
  return (idx === -1 ? glob : glob.slice(0, idx)).replace(/\/+$/, "");
}

/**
 * TeamManager（M1 全量：实体 + roster + 投递 + 看板 + 治理）：团队生命周期、成员名册、
 * 进程内路由与唤醒、共享任务板、关机编排与僵尸清扫。挂在 lead 的 app 装配里，随主会话
 * 存续；跨进程互斥由磁盘上的 leadPid 活性判定兜底。
 *
 * 投递（通信层下半场）：成员收件经装配的 TeamDeliveryTarget 送进 lead 进程的子代理任务
 * 注册表——busy 成员 steer 进活跃 turn，idle 成员带消息后台复活；lead 收件入队信箱
 * （M3 轮询后端 500ms 注入 lead 的活跃 turn；信箱条目带 deliveredAt 消费语义，未消费
 * 条目跨崩溃/接管经复活简报补送）。
 *
 * 配额（M3，设计 2.4 的 4/32/32KiB）：单条 32KiB、单对在途 4、单箱在途 32——死信箱
 * 对发送方形成背压。
 *
 * 看板（设计 2.5）：内存是唯一真相（M1 无接管读方），board.json 是 best-effort 镜像；
 * caller 身份由端口闭包绑定——成员只能认领（unowned pending → in_progress）/完成/归还自己的
 * 任务，指派与取消仅 lead；一人一 in_progress 任务；blockedBy 全终态才可开跑。
 * 自动认领的 M1 形态 = 完成回包带下一步可认领提示，由完成者自续跑（spawn 即唤醒源）。
 *
 * 治理（设计 2.7，PR6）：deleteTeam = 停成员任务 → 除名（释放任务）→ 归档（token 应答
 * 握手随 M3 跨进程再上，进程内 lead 拥有成员任务，应答是仪式）；僵尸清扫在 collectTasks
 * 入口——成员任务 failed/missing 而人还在名册 → 自动除名释放，防「永远 in_progress」。
 */
export class TeamManager {
  private active: { name: string; generation: number } | undefined;
  private roster: TeamMember[] = [];
  private tasks: TeamTask[] = [];
  private nextTaskId = 1;
  private deliveryTarget: TeamDeliveryTarget | undefined;
  private memberControl: TeamMemberControlTarget | undefined;
  private teamHook: TeamHookTarget | undefined;
  private leadInboxTarget: TeamLeadInboxTarget | undefined;
  private inboxTimer: ReturnType<typeof setInterval> | undefined;
  private pollTicking = false;
  private injectFailureStreak = 0;
  /** run 级 TeammateIdle 去重：成员重新 running 即清零（见 detectMemberIdle）。 */
  private readonly idleNotified = new Set<string>();

  constructor(
    private readonly store: TeamStore,
    private readonly leadSessionId: string,
    private readonly logger?: Logger,
    private readonly maxTeammates: number = DEFAULT_MAX_TEAMMATES,
    /** lead 的仓库根（M2 隔离层）：writer worktree 的创建基点与回收登记处。 */
    private readonly workspaceRoot: string = process.cwd(),
  ) {}

  /** 装配期挂投递钩子（bootstrap 在 AgentRuntime 构造后回填 lead 侧 subagent 端口）。 */
  attachDeliveryTarget(target: TeamDeliveryTarget | undefined): void {
    this.deliveryTarget = target;
  }

  /** 装配期挂成员控制钩子（同一端口）：关机停任务 + 僵尸清扫探测。 */
  attachMemberControl(control: TeamMemberControlTarget | undefined): void {
    this.memberControl = control;
  }

  /** 装配期挂团队 hooks 触发钩子（TaskCompleted/TeammateIdle，通知型）。 */
  attachTeamHook(target: TeamHookTarget | undefined): void {
    this.teamHook = target;
  }

  /** 装配期挂 lead 信箱注入钩子（M3 轮询后端：bootstrap 包 runtime.steerTurn）。 */
  attachLeadInbox(target: TeamLeadInboxTarget | undefined): void {
    this.leadInboxTarget = target;
  }

  /** 通知型 hook：失败只告警，绝不影响业务应答（fire-and-forget）。 */
  private notifyTeamHook(input: TeamHookNotification): void {
    if (this.teamHook === undefined) return;
    void this.teamHook.runTeamHook(input).catch((error) => {
      this.logger?.warn?.("Team hook notification failed", {
        module: "core.agent.team",
        hookEventName: input.hookEventName,
        error: errorMessage(error),
      });
    });
  }

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
        // 被归档团队名下可能带着未回收的 worktree：目录随团队一起移进 .archive 后，
        // git 侧登记悬挂，prune 清掉（分支与归档副本保留，事后仍可抢救）。
        await runGit(this.workspaceRoot, ["worktree", "prune"]);
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
      this.tasks = [];
      this.nextTaskId = 1;
      this.startInboxPolling();
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

  /**
   * 关机编排（设计 2.5 生命周期的 M1 进程内形态）：世代校验 → 停全部成员任务 →
   * 逐个除名（释放名下任务）→ 归档。token 应答/可拒收语义随 M3 跨进程再上——
   * 进程内 lead 拥有成员任务，应答是仪式；成员迟到的 team_send 会被路由白名单挡住。
   */
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
      let stopped = 0;
      // removeMember 以 filter 重赋值 roster，for-of 持旧数组引用，迭代稳定。
      for (const member of this.roster) {
        if (member.agentId !== undefined && this.memberControl) {
          try {
            await this.memberControl.stopAgent(member.agentId);
            stopped += 1;
          } catch (error) {
            // 停不掉不阻断关机：任务稍后自灭于进程退出，除名后路由白名单也不再认它。
            this.logger?.warn?.("Team shutdown: stopping member task failed", {
              module: "core.agent.team",
              team: name,
              member: member.name,
              agentId: member.agentId,
              error: errorMessage(error),
            });
          }
        }
        const removed = await this.removeMember(member.name, "team shutdown");
        if (removed.status === "failed") {
          return failed(`Team '${name}' shutdown stalled: ${removed.error ?? removed.message}`, name);
        }
      }
      await this.store.archiveTeam(name);
      await runGit(this.workspaceRoot, ["worktree", "prune"]);
      this.stopInboxPolling();
      this.active = undefined;
      this.roster = [];
      this.tasks = [];
      this.nextTaskId = 1;
      this.logger?.info?.("Team deleted", { module: "core.agent.team", team: name });
      return {
        status: "success",
        teamName: name,
        message:
          stopped > 0
            ? `Team '${name}' shut down (${stopped} member task(s) stopped) and archived.`
            : `Team '${name}' shut down and archived.`,
      };
    } catch (error) {
      return failed(`Team deletion failed: ${errorMessage(error)}`, name);
    }
  }

  /**
   * 接管（M3，设计 2.3/2.9 验收「杀 lead → 新会话接管继续」）：原 lead 进程死亡后，
   * 本会话收编磁盘团队——世代 +1 换 lead 身份、成员全标死亡（agentId 随旧进程作废，
   * worktree 保留）、释放成员 in_progress 任务、看板与信箱原样入内存。活 pid 拒绝；
   * completed 未合流任务保留 owner（merge gate 按 owner 认分支）。
   */
  async adoptTeam(request: TeamAdoptRequest): Promise<TeamAdoptResult> {
    if (this.active) {
      return adoptFailed(
        `Team '${this.active.name}' is already active. Delete it before adopting another.`,
      );
    }
    try {
      const config = await this.store.readConfig(request.name);
      if (isPidAlive(config.leadPid)) {
        return adoptFailed(
          `Team '${request.name}' is still active in another session (pid ${config.leadPid}). Use it there, or delete it first.`,
        );
      }
      const board = await this.store.readBoard(request.name);
      const members: TeamMember[] = config.members.map((member) => ({
        ...member,
        agentId: undefined,
        state: "stopped" as const,
      }));
      const generation = config.generation + 1;
      await this.store.writeConfig(request.name, {
        ...config,
        members,
        leadSessionId: this.leadSessionId,
        leadPid: process.pid,
        generation,
      });
      this.active = { name: request.name, generation };
      this.roster = members;
      this.tasks = board.tasks;
      this.nextTaskId = board.nextId;
      let releasedTasks = 0;
      for (const member of members) {
        releasedTasks += this.releaseOwnedTasks(member.name);
      }
      if (releasedTasks > 0) {
        await this.persistBoard();
      }
      // 在途消息盘点：lead 的经轮询注入；成员的在复活简报补送（不在此消费）。
      let pendingMessages = 0;
      for (const boxOwner of ["lead", ...members.map((member) => member.name)]) {
        const inbox = await this.readInboxState(boxOwner);
        pendingMessages += inbox.messages.filter((message) => message.deliveredAt === undefined)
          .length;
      }
      this.startInboxPolling();
      this.logger?.info?.("Team adopted", {
        module: "core.agent.team",
        team: request.name,
        generation,
        adoptedMembers: members.length,
        releasedTasks,
      });
      return {
        status: "success",
        teamName: request.name,
        generation,
        adoptedMembers: members.length,
        releasedTasks,
        pendingMessages,
        message:
          `Team '${request.name}' adopted (generation ${generation}). ` +
          `${members.length} teammate(s) marked dead — revive each with team_spawn_teammate using the same name.` +
          (releasedTasks > 0
            ? ` ${releasedTasks} task(s) were released back to the board.`
            : "") +
          (pendingMessages > 0
            ? ` ${pendingMessages} undelivered message(s) preserved: yours will be injected into your next turn; teammates' replay on revival.`
            : ""),
      };
    } catch (error) {
      return adoptFailed(`Team adoption failed: ${errorMessage(error)}`);
    }
  }

  /** 复活补送读取（M3）：成员信箱在途消息（不消费——消费在 spawn 确认后显式标记）。 */
  async readMemberPendingMessages(memberName: string): Promise<TeamPendingMessage[]> {
    if (!this.active) return [];
    const inbox = await this.readInboxState(memberName);
    return inbox.messages
      .filter((message) => message.deliveredAt === undefined)
      .map(({ messageId, from, summary, message, queuedAt }) => ({
        messageId,
        from,
        summary,
        message,
        queuedAt,
      }));
  }

  async markMemberMessagesDelivered(memberName: string, messageIds: string[]): Promise<void> {
    if (!this.active || messageIds.length === 0) return;
    try {
      await this.store.markInboxDelivered(this.active.name, memberName, messageIds);
    } catch (error) {
      this.logger?.warn?.("Team inbox replay-mark failed", {
        module: "core.agent.team",
        team: this.active.name,
        member: memberName,
        error: errorMessage(error),
      });
    }
  }

  async reserveMember(registration: TeamMemberRegistration): Promise<TeamRosterResult> {
    if (!this.active) {
      return rosterFailed("No active team. Create a team first with team_create.");
    }
    if (registration.name === "lead") {
      return rosterFailed("'lead' is reserved for the lead; pick another teammate name.");
    }
    let revival = false;
    const existing = this.roster.find((member) => member.name === registration.name);
    if (existing !== undefined) {
      // M3 复活：stopped/failed 成员同名重 spawn（复用 worktree 与信箱在途消息）；
      // 其余状态（spawning/idle/busy）仍是重名拒绝。
      if (existing.state !== "stopped" && existing.state !== "failed") {
        return rosterFailed(`Teammate '${registration.name}' already exists.`);
      }
      revival = true;
      const heldWorktree = existing.worktreePath;
      this.roster = this.roster.filter((member) => member.name !== registration.name);
      this.roster.push({
        name: registration.name,
        profile: registration.profile ?? existing.profile,
        readOnly: registration.readOnly ?? existing.readOnly,
        maxTurns: registration.maxTurns ?? existing.maxTurns,
        state: "spawning",
        // 复用旧树（setupMemberWorkspace 走 attach 路径）；转成 readOnly 复活则弃树。
        ...(heldWorktree !== undefined && registration.readOnly !== true
          ? { worktreePath: heldWorktree }
          : {}),
      });
      if (heldWorktree !== undefined && registration.readOnly === true) {
        const removed = await removeWorktree(this.workspaceRoot, heldWorktree);
        if (!removed.ok) {
          this.logger?.warn?.("Revival worktree reclaim failed; left for manual cleanup", {
            module: "core.agent.team",
            team: this.active.name,
            member: registration.name,
            worktreePath: heldWorktree,
            error: removed.error,
          });
        }
      }
    } else {
      if (this.roster.length >= this.maxTeammates) {
        return rosterFailed(
          `Team is full (${this.maxTeammates} teammates; adjust settings key team.maxTeammates). Finish work before spawning more.`,
        );
      }
      this.roster.push({
        name: registration.name,
        ...(registration.profile ? { profile: registration.profile } : {}),
        ...(registration.readOnly !== undefined ? { readOnly: registration.readOnly } : {}),
        ...(registration.maxTurns !== undefined ? { maxTurns: registration.maxTurns } : {}),
        state: "spawning",
      });
    }
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
      message: revival
        ? `Teammate '${registration.name}' reserved for revival (worktree and queued messages are kept).`
        : `Teammate '${registration.name}' reserved.`,
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
    // 成员就绪即可派活——TeammateIdle 通知型 hook（设计 2.7）。spawn 是新的空闲收束：
    // 清去重再通知（成员可能带着旧标记重入名册）。
    this.idleNotified.delete(memberName);
    this.notifyTeamHook({
      hookEventName: "TeammateIdle",
      memberName,
      teamName: this.active.name,
    });
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
    // M2：先回收 worktree（成员的独立树随除名消失，分支留待 lead merge 或丢弃）。
    // 回收失败不阻断除名——残留树是磁盘垃圾不是正确性问题，prune 后续可清。
    if (member.worktreePath !== undefined) {
      const removed = await removeWorktree(this.workspaceRoot, member.worktreePath);
      if (!removed.ok) {
        this.logger?.warn?.("Team worktree removal failed; left for manual cleanup", {
          module: "core.agent.team",
          team: this.active.name,
          member: member.name,
          worktreePath: member.worktreePath,
          error: removed.error,
        });
      }
    }
    this.roster = this.roster.filter((entry) => entry.name !== memberName);
    const persistError = await this.persistRoster();
    if (persistError) {
      // 回滚失败意味着磁盘与内存名册分叉——把成员放回去并如实报错，交上层决策。
      this.roster.push(member);
      return rosterFailed(`Teammate removal could not be persisted: ${persistError}`, memberName);
    }
    // 认领协议的归还半边（设计 2.5）：成员终止 → 名下未终态任务释放回看板重新可认领。
    const released = this.releaseOwnedTasks(memberName);
    if (released > 0) {
      await this.persistBoard();
    }
    const releaseNote = released > 0 ? ` ${released} task(s) released back to the board.` : "";
    return {
      status: "success",
      teamName: this.active.name,
      memberName,
      roster: [...this.roster],
      message: reason
        ? `Teammate '${memberName}' removed: ${reason}.${releaseNote}`
        : `Teammate '${memberName}' removed.${releaseNote}`,
    };
  }

  private releaseOwnedTasks(memberName: string): number {
    let released = 0;
    for (const task of this.tasks) {
      if (task.owner === memberName && !isTaskTerminal(task.status)) {
        task.owner = undefined;
        if (task.status === "in_progress") task.status = "pending";
        task.updatedAt = new Date().toISOString();
        released += 1;
      }
    }
    return released;
  }

  // ============================================================
  // 隔离层（M2，设计 2.6）：writer worktree + 写策略
  // ============================================================

  /**
   * writer 成员 spawn 前建独立 worktree + 分支（基于 lead 仓库当前 HEAD）。
   * 树放在团队目录下（worktrees/{member}），随团队生命周期回收。非 git 仓库、
   * git 失败均如实返回，调用方（spawn handler）回滚 roster 占位。
   */
  async setupMemberWorkspace(memberName: string): Promise<TeamMemberWorkspaceResult> {
    if (!this.active) {
      return workspaceFailed("No active team. Create a team first with team_create.");
    }
    const member = this.roster.find((entry) => entry.name === memberName);
    if (!member) {
      return workspaceFailed(`Teammate '${memberName}' is not on the roster.`);
    }
    if (member.worktreePath !== undefined) {
      // M3 复活重挂：占位条目带着旧树路径（reserveMember 复用）——目录在则原样复用；
      // 目录被删则把既有分支挂回去。树损（.git 指针没了）按目录已删处理。
      if (!(await isGitRepository(this.workspaceRoot))) {
        return workspaceFailed(
          `Writer teammates need a git repository at '${this.workspaceRoot}'. ` +
            "Spawn readOnly teammates in non-git projects, or git init first.",
        );
      }
      const branch = `zcode-team/${this.active.name}/${memberName}`;
      let worktreeIntact = false;
      try {
        worktreeIntact = (await stat(join(member.worktreePath, ".git"))).isFile();
      } catch {
        worktreeIntact = false;
      }
      if (!worktreeIntact) {
        await rm(member.worktreePath, { recursive: true, force: true });
        const attached = await attachWorktree(this.workspaceRoot, member.worktreePath, branch);
        if (!attached.ok) {
          return workspaceFailed(attached.error);
        }
      }
      return {
        status: "success",
        workspace: { worktreePath: member.worktreePath, branch },
        message: `Teammate '${memberName}' worktree reused at ${member.worktreePath}.`,
      };
    }
    if (!(await isGitRepository(this.workspaceRoot))) {
      return workspaceFailed(
        `Writer teammates need a git repository at '${this.workspaceRoot}'. ` +
          "Spawn readOnly teammates in non-git projects, or git init first.",
      );
    }
    const worktreePath = join(
      this.store.location(this.active.name).teamDir,
      "worktrees",
      memberName,
    );
    const branch = `zcode-team/${this.active.name}/${memberName}`;
    const created = await createWorktree(this.workspaceRoot, worktreePath, branch);
    if (!created.ok) {
      return workspaceFailed(created.error);
    }
    member.worktreePath = worktreePath;
    const persistError = await this.persistRoster();
    if (persistError) {
      // 落盘失败回滚半成品树，roster 留在调用方的 removeMember 兜底里。
      member.worktreePath = undefined;
      const undone = await removeWorktree(this.workspaceRoot, worktreePath);
      return workspaceFailed(
        `Teammate workspace could not be persisted: ${persistError}` +
          (undone.ok ? "" : " (worktree left behind; manual cleanup needed)"),
      );
    }
    this.logger?.info?.("Team member worktree created", {
      module: "core.agent.team",
      team: this.active.name,
      member: memberName,
      worktreePath,
      branch,
    });
    return {
      status: "success",
      workspace: { worktreePath, branch },
      message: `Worktree '${branch}' ready at ${worktreePath}.`,
    };
  }

  /** 写策略快照（注入缝 veto 用）：树边界 spawn 期定死，scope 随认领动态取。 */
  getMemberWritePolicy(memberName: string): TeamMemberWritePolicy {
    const member = this.roster.find((entry) => entry.name === memberName);
    if (member === undefined) return {};
    // reviewer 型成员（readOnly）：无树且一切文件写被拒（M2 硬化，设计 2.6）。
    if (member.readOnly === true) return { readOnly: true };
    if (member.worktreePath === undefined) return {};
    const held = this.tasks.find(
      (task) => task.owner === memberName && task.status === "in_progress",
    );
    return {
      worktreePath: member.worktreePath,
      ...(held?.scope !== undefined && held.scope.length > 0 ? { scope: [...held.scope] } : {}),
    };
  }

  /**
   * worklog 落盘（M2 兑现 M1 的路径承诺，真机验收遗留②）：任务终态时写骨架。
   * best-effort——失败告警不阻断完成应答。
   */
  private async writeWorklog(task: TeamTask): Promise<void> {
    if (!this.active || task.worklog === undefined) return;
    const lines = [
      `# Task #${task.id}: ${task.subject}`,
      "",
      `- status: ${task.status}`,
      `- owner: ${task.owner ?? "(none)"}`,
      ...(task.scope !== undefined ? [`- scope: ${task.scope.join(", ")}`] : []),
      `- created: ${task.createdAt}`,
      `- updated: ${task.updatedAt}`,
      "",
      ...(task.description !== undefined ? ["## Description", "", task.description, ""] : []),
    ];
    try {
      await this.store.writeWorklog(this.active.name, task.id, `${lines.join("\n")}\n`);
    } catch (error) {
      this.logger?.warn?.("Team worklog write failed", {
        module: "core.agent.team",
        team: this.active.name,
        taskId: task.id,
        error: errorMessage(error),
      });
    }
  }

  /**
   * 路由（实体层 + 投递）：roster 白名单校验 → 投递（成员收件 steer/复活，lead 收件入队）
   * → 持久化镜像。每条消息必有明确结局（送达/入队/拒绝，设计 2.4）。
   * `*` 广播含 lead、逐个投递，部分失败收集进 failedRecipients（全部失败才整体
   * failed——设计 2.4 广播降级 M2 的落地形态）。
   * peer 点对点投递自动向 lead 信箱写一行摘要（cc-lead，设计 2.4：lead 对网状对话保持可见）。
   */
  async route(from: string, to: string, request: TeamSendMessage): Promise<TeamSendResult> {
    if (!this.active) {
      return sendFailed("No active team. Create a team first with team_create.");
    }
    if (to === from) {
      return sendFailed("Cannot send a team message to yourself.");
    }
    if (to === "*") {
      return this.broadcast(from, request);
    }
    const toMember = to === "lead" ? undefined : this.roster.find((member) => member.name === to);
    if (to !== "lead" && !toMember) {
      return sendFailed(
        `Unknown teammate '${to}'. Current roster: lead${this.roster.map((m) => `, ${m.name}`).join("")}.`,
      );
    }
    if (toMember?.state === "spawning") {
      return sendFailed(`Teammate '${to}' is still spawning; retry shortly.`);
    }
    const messageId = `teammsg_${randomUUID()}`;
    const entry = {
      messageId,
      from,
      to,
      summary: request.summary,
      message: request.message,
      queuedAt: new Date().toISOString(),
    };
    // M3 细粒度配额（4/32/32KiB）：检查先于写入——被拒的消息不落信箱。在途 = 无
    // deliveredAt 的条目；死信箱对发送方形成背压（等收件方消费或复活补送）。
    const payloadBytes = Buffer.byteLength(`${request.summary}\n${request.message}`, "utf8");
    if (payloadBytes > TEAM_MESSAGE_MAX_BYTES) {
      return sendFailed(
        `Message too large: ${payloadBytes} bytes (limit ${TEAM_MESSAGE_MAX_BYTES}). Split it or send a file path instead.`,
      );
    }
    const inbox = await this.readInboxState(to);
    const inflight = inbox.messages.filter((message) => message.deliveredAt === undefined);
    const pairInflight = inflight.filter((message) => message.from === from).length;
    if (pairInflight >= TEAM_PAIR_INFLIGHT_MAX) {
      return sendFailed(
        `Cannot send to '${to}': ${pairInflight} of your messages are still in flight there (limit ${TEAM_PAIR_INFLIGHT_MAX}). Wait for pickup first.`,
      );
    }
    if (inflight.length >= TEAM_INBOX_INFLIGHT_MAX) {
      return sendFailed(
        `Cannot send to '${to}': their inbox already holds ${inflight.length} undelivered message(s) (limit ${TEAM_INBOX_INFLIGHT_MAX}).`,
      );
    }
    // M3 先写后投递：条目先落盘（在途），投递结局达成后标记消费——中途崩溃或接管时，
    // 未消费条目经轮询注入（lead）或复活简报补送（成员）不丢消息。
    await this.enqueueInbox(to, entry);
    // lead 收件：无任务可 steer，入队即结局；轮询后端 500ms 内注入 lead 的活跃 turn。
    if (to === "lead") {
      return {
        status: "success",
        messageId,
        message: "Message queued for lead.",
        delivery: "queued",
      };
    }
    if (!this.deliveryTarget) {
      return sendFailed(
        `Teammate '${to}' cannot receive messages right now: delivery is unavailable (subagents disabled?). The message stays in their inbox and will be replayed when they are revived.`,
      );
    }
    // 投递键是 agentId：lead 进程的任务注册表按它索引（成员名仅作镜像/报错身份）。
    const delivered = await this.deliveryTarget.sendMessage(
      {
        memberName: to,
        ...(toMember?.agentId !== undefined ? { agentId: toMember.agentId } : {}),
      },
      {
        summary: request.summary,
        message: request.message,
        trace: request.trace,
        ...(request.delivery === "interject" ? { interrupt: true } : {}),
      },
    );
    if (delivered.status === "failed") {
      const reviveHint =
        toMember !== undefined && toMember.agentId === undefined
          ? ` Teammate '${to}' has no live agent; the message stays queued in their inbox and will replay when you revive them (team_spawn_teammate '${to}').`
          : "";
      return sendFailed(
        `Delivery to teammate '${to}' failed: ${delivered.error ?? delivered.message ?? "unknown error"}.${reviveHint}`,
      );
    }
    void this.markDelivered(to, messageId);
    if (from !== "lead") {
      void this.enqueueInbox("lead", {
        ...entry,
        messageId: `${messageId}_cc`,
        summary: `[cc-lead] ${from} → ${to}: ${request.summary}`,
        message: `${from} sent to ${to}: ${request.message}`,
      });
    }
    const delivery = delivered.delivery ?? "queued";
    return {
      status: "success",
      messageId,
      message:
        delivery === "interrupted"
          ? `Interrupted teammate '${to}'s active run and resumed it with your message.`
          : delivery === "resumed_background"
            ? `Teammate '${to}' was idle; resumed in the background with your message.`
            : delivery === "steered"
              ? `Message delivered into the active turn of teammate '${to}'.`
              : `Message queued for ${to}.`,
      delivery,
    };
  }

  /** 广播（`*`）：lead + 全部就绪成员逐个投递；单点失败不中止其余（设计 2.4）。 */
  private async broadcast(from: string, request: TeamSendMessage): Promise<TeamSendResult> {
    const messageId = `teammsg_${randomUUID()}`;
    const recipients = [
      ...(from === "lead" ? [] : ["lead"]),
      ...this.roster.filter((member) => member.state !== "spawning").map((member) => member.name),
    ];
    if (recipients.length === 0) {
      return sendFailed("Broadcast has no recipients.");
    }
    const failedRecipients: string[] = [];
    let delivered = 0;
    for (const recipient of recipients) {
      const result = await this.route(from, recipient, request);
      if (result.status === "failed") {
        failedRecipients.push(`${recipient} (${result.error ?? result.message})`);
      } else {
        delivered += 1;
      }
    }
    if (delivered === 0) {
      return {
        status: "failed",
        messageId,
        message: `Broadcast failed for all ${failedRecipients.length} recipient(s).`,
        error: failedRecipients.join("; "),
        failedRecipients: failedRecipients.map(entry => entry.split(" (")[0]),
      };
    }
    return {
      status: "success",
      messageId,
      message:
        failedRecipients.length > 0
          ? `Broadcast delivered to ${delivered} recipient(s); failed for ${failedRecipients.length}: ${failedRecipients.join("; ")}.`
          : `Broadcast delivered to ${delivered} recipient(s).`,
      ...(failedRecipients.length > 0
        ? { failedRecipients: failedRecipients.map(entry => entry.split(" (")[0]) }
        : {}),
    };
  }

  // ============================================================
  // 共享看板（设计 2.5）
  // ============================================================

  async createTask(request: TeamTaskCreateRequest): Promise<TeamTaskCreateResult> {
    if (!this.active) {
      return taskFailed("No active team. Create a team first with team_create.");
    }
    const missing = (request.blockedBy ?? []).filter(
      (id) => !this.tasks.some((task) => task.id === id),
    );
    if (missing.length > 0) {
      return taskFailed(`Unknown task id(s) in blocked_by: ${missing.join(", ")}.`);
    }
    // M2 scope 不相交断言（设计 2.6「plan 时断言，重叠报错给 lead」）：与全部
    // 未终态任务的 scope 两两判交；保守近似（通配前缀祖先判定），宁可误报不可漏报。
    if (request.scope !== undefined && request.scope.length > 0) {
      for (const existing of this.tasks) {
        if (isTaskTerminal(existing.status) || existing.scope === undefined) continue;
        const overlap = request.scope.find((glob) =>
          existing.scope!.some((other) => scopesOverlap(glob, other)),
        );
        if (overlap !== undefined) {
          return taskFailed(
            `Scope '${overlap}' overlaps with task #${existing.id} scope [${existing.scope.join(", ")}]. ` +
              "Parallel writers must not intersect; finish the other task first or split the scopes.",
          );
        }
      }
    }
    const id = String(this.nextTaskId++);
    const now = new Date().toISOString();
    const task: TeamTask = {
      id,
      subject: request.subject,
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.activeForm !== undefined ? { activeForm: request.activeForm } : {}),
      status: "pending",
      blockedBy: [...(request.blockedBy ?? [])],
      ...(request.sharedContext !== undefined && request.sharedContext.length > 0
        ? { sharedContext: [...request.sharedContext] }
        : {}),
      ...(request.scope !== undefined && request.scope.length > 0
        ? { scope: [...request.scope] }
        : {}),
      worklog: `worklogs/${id}.md`,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    await this.persistBoard();
    return {
      status: "success",
      taskId: id,
      task: this.withBlocks(task),
      message:
        request.blockedBy !== undefined && request.blockedBy.length > 0
          ? `Task #${id} created (blocked by ${request.blockedBy.join(", ")}).`
          : `Task #${id} created.`,
    };
  }

  async listTasks(): Promise<TeamTaskListResult> {
    if (!this.active) {
      return { status: "failed", tasks: [], message: "No active team.", error: "No active team." };
    }
    return {
      status: "success",
      teamName: this.active.name,
      tasks: this.boardView(),
      message: this.boardSummary(),
    };
  }

  async queryTask(request: TeamTaskQueryRequest): Promise<TeamTaskQueryResult> {
    const task = this.tasks.find((entry) => entry.id === request.taskId);
    if (!task) {
      return taskFailed(
        `Unknown task id '${request.taskId}'. Open tasks: ${this.taskIdHint()}.`,
      );
    }
    return {
      status: "success",
      task: this.withBlocks(task),
      message: `Task #${task.id} '${task.subject}' is ${task.status}${task.owner ? ` (owner ${task.owner})` : ""}.`,
    };
  }

  /**
   * 状态机与 ACL 全走这里（先全量校验后落笔，一步原子）：
   * 认领 = 无主 pending → in_progress（owner 闭包身份）；归还 = in_progress → pending（清 owner）；
   * 完成 = 自己的 in_progress → completed；取消 = 仅 lead；blockedBy 全终态才允许 in_progress。
   */
  async updateTask(caller: string, request: TeamTaskUpdateRequest): Promise<TeamTaskUpdateResult> {
    if (!this.active) {
      return taskFailed("No active team. Create a team first with team_create.");
    }
    const task = this.tasks.find((entry) => entry.id === request.taskId);
    if (!task) {
      return taskFailed(`Unknown task id '${request.taskId}'. Open tasks: ${this.taskIdHint()}.`);
    }
    if (isTaskTerminal(task.status)) {
      return taskFailed(`Task #${task.id} is already ${task.status}; terminal entries are immutable.`);
    }
    const isLead = caller === "lead";
    const before = { ...task };

    let ownerToSet: string | undefined;
    if (request.owner !== undefined && request.owner !== task.owner) {
      if (!isLead) {
        return taskFailed(
          "Only the lead can assign or reassign tasks; claim an unowned task with task_update status=in_progress.",
        );
      }
      if (request.owner !== "lead" && !this.roster.some((member) => member.name === request.owner)) {
        return taskFailed(`'${request.owner}' is not on the roster.`);
      }
      ownerToSet = request.owner;
    }

    let claimOwner: string | undefined;
    if (request.status !== undefined && request.status !== task.status) {
      const failure = this.validateStatusTransition(caller, isLead, task, request.status, ownerToSet);
      if (failure) {
        return taskFailed(failure);
      }
      if (
        request.status === "in_progress" &&
        (ownerToSet ?? task.owner) === undefined
      ) {
        claimOwner = caller;
      }
    }

    if (
      ownerToSet === undefined &&
      claimOwner === undefined &&
      (request.status === undefined || request.status === task.status)
    ) {
      return {
        status: "success",
        task: this.withBlocks(task),
        message: `Task #${task.id} unchanged (${task.status}${task.owner ? `, owner ${task.owner}` : ""}).`,
      };
    }

    // M2 隔离层：writer 完成任务 = 系统代提交其 worktree（成员不用管 git），
    // commit 失败如实中断——任务留 in_progress，成员修好状态再完成。
    if (request.status === "completed" && before.status !== "completed") {
      const owner = ownerToSet ?? task.owner;
      const member = owner === undefined ? undefined : this.roster.find((m) => m.name === owner);
      if (member?.worktreePath !== undefined) {
        const committed = await commitAll(
          member.worktreePath,
          `team: task #${task.id} ${task.subject}`,
        );
        if (!committed.ok) {
          return taskFailed(
            `Task #${task.id} cannot be completed: ${committed.error}. ` +
              "The worktree state is left as-is; resolve git (e.g. identity config) and complete again.",
          );
        }
      }
    }

    if (ownerToSet !== undefined) task.owner = ownerToSet;
    if (claimOwner !== undefined) task.owner = claimOwner;
    if (request.status !== undefined && request.status !== before.status) {
      task.status = request.status;
    }
    // 归还清 owner：任务回板，任何人可再认领。
    if (request.status === "pending" && before.status === "in_progress") {
      task.owner = undefined;
    }
    task.updatedAt = new Date().toISOString();
    if (isTaskTerminal(task.status)) {
      await this.writeWorklog(task);
    }
    await this.persistBoard();
    if (task.status === "completed" && this.active) {
      this.notifyTeamHook({
        hookEventName: "TaskCompleted",
        owner: task.owner,
        subject: task.subject,
        taskId: task.id,
        teamName: this.active.name,
      });
      // 完成回包提示过下一步可认领；无活可干即空闲——TeammateIdle 通知（设计 2.7）。
      // 与轮询器共用 fireTeammateIdleOnce 去重：同一次空闲收束只通知一次。
      if (this.claimableTasks().length === 0 && task.owner !== undefined) {
        this.fireTeammateIdleOnce(task.owner);
      }
    }
    return {
      status: "success",
      task: this.withBlocks(task),
      message: this.updateMessage(before, task),
    };
  }

  /** 合流（设计 2.5）：等调用时刻的非终态任务到达终态；超时带部分结果。 */
  async collectTasks(
    request: TeamCollectRequest,
    signal?: AbortSignal,
  ): Promise<TeamCollectResult> {
    if (!this.active) {
      return { status: "failed", tasks: [], message: "No active team.", error: "No active team." };
    }
    // 僵尸清扫挂在 collect 入口（lead 的自然同步点）：成员任务 failed/missing 而人还在
    // 名册 → 除名并释放任务，否则下述等待会被「永远 in_progress」的任务拖死。
    const swept = await this.sweepZombieMembers();
    const sweepNote =
      swept.length > 0 ? ` Dead member(s): ${swept.join("; ")}.` : "";
    const timeoutMs = Math.min(
      Math.max(request.timeoutMs ?? TEAM_COLLECT_DEFAULT_TIMEOUT_MS, TEAM_COLLECT_MIN_TIMEOUT_MS),
      TEAM_COLLECT_MAX_TIMEOUT_MS,
    );
    const requireAll = request.requireAll ?? true;
    const targets = this.tasks.filter((task) => !isTaskTerminal(task.status));
    const targetIds = new Set(targets.map((task) => task.id));
    const countTerminal = () =>
      this.tasks.filter((task) => targetIds.has(task.id) && isTaskTerminal(task.status)).length;
    const reached = () =>
      requireAll ? countTerminal() === targets.length : countTerminal() >= 1;
    if (targets.length > 0 && !reached()) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && signal?.aborted !== true) {
        await delay(COLLECT_POLL_INTERVAL_MS);
        if (reached()) break;
      }
    }
    const terminalCount = countTerminal();
    const status =
      targets.length === 0 || terminalCount === targets.length
        ? ("completed" as const)
        : terminalCount > 0
          ? ("partial" as const)
          : ("timeout" as const);
    const message =
      status === "completed"
        ? targets.length === 0
          ? `No open tasks on the board.${sweepNote}`
          : `All ${targets.length} tracked task(s) reached a terminal state.${sweepNote}`
        : status === "partial"
          ? `${terminalCount} of ${targets.length} tracked task(s) finished; the rest are still open (deadline reached).${sweepNote}`
          : `None of the ${targets.length} tracked task(s) finished before the deadline.${sweepNote}`;
    const mergeWarnings = await this.detectMergeConflicts();
    return {
      status,
      tasks: this.boardView(),
      message,
      ...(mergeWarnings.length > 0 ? { mergeWarnings } : {}),
    };
  }

  /**
   * merge gate（设计 2.6，M2）：七类机械断言后把 completed 任务的 owner 分支合入
   * 主 checkout。断言顺序便宜先行；每类拒绝带下一步指引（kimi 风格）。已 merge
   * 的任务幂等重入（直接成功返回）。
   */
  async mergeTask(request: TeamMergeRequest): Promise<TeamMergeResult> {
    if (!this.active) {
      return mergeRejected(undefined, undefined, "No active team. Create a team first with team_create.");
    }
    const task = this.tasks.find((entry) => entry.id === request.taskId);
    if (!task) {
      return mergeRejected(
        request.taskId,
        undefined,
        `Unknown task id '${request.taskId}'. Open tasks: ${this.taskIdHint()}.`,
      );
    }
    if (task.status !== "completed") {
      return mergeRejected(
        task.id,
        "task_not_completed",
        `Task #${task.id} is ${task.status}; only completed work merges. Move it to completed (task_update status=completed) first.`,
      );
    }
    if (task.mergedAt !== undefined) {
      return {
        status: "success",
        taskId: task.id,
        task: this.withBlocks(task),
        message: `Task #${task.id} was already merged at ${task.mergedAt}.`,
      };
    }
    const owner = task.owner ?? "(none)";
    const member = task.owner === undefined ? undefined : this.roster.find((m) => m.name === task.owner);
    if (member === undefined || member.worktreePath === undefined) {
      return mergeRejected(
        task.id,
        "owner_not_isolated",
        `Task #${task.id} owner '${owner}' has no isolated worktree (removed or read-only). ` +
          `Merge branch 'zcode-team/${this.active.name}/${owner}' manually if it still exists.`,
      );
    }
    const busy = this.tasks.find(
      (entry) => entry.id !== task.id && entry.owner === task.owner && entry.status === "in_progress",
    );
    if (busy) {
      return mergeRejected(
        task.id,
        "member_busy",
        `Teammate '${owner}' still holds task #${busy.id} in progress; its in-flight changes would ride along. Wait for completion or release it first.`,
      );
    }
    if (await isWorktreeDirty(member.worktreePath)) {
      return mergeRejected(
        task.id,
        "dirty_worktree",
        `Teammate '${owner}' worktree has uncommitted changes. Ask them to finish/complete their task (completing auto-commits), then merge again.`,
      );
    }
    if (await isCheckoutDirty(this.workspaceRoot)) {
      return mergeRejected(
        task.id,
        "dirty_worktree",
        "The main checkout has uncommitted changes; commit or stash them before merging teammate branches.",
      );
    }
    const branch = `zcode-team/${this.active.name}/${task.owner}`;
    const base = await mergeBaseOf(this.workspaceRoot, branch);
    if (!base.ok) {
      return mergeRejected(task.id, "git_error", base.error);
    }
    const diff = await diffFiles(this.workspaceRoot, base.base, branch);
    if (!diff.ok) {
      return mergeRejected(task.id, "git_error", diff.error);
    }
    // out_of_scope：owner 全部 completed 任务里只要有任意无 scope 的，机械断言失去
    // 判界依据，跳过（diff 明细仍在成功应答里给 lead 看）；否则 diff 必须落在并集内。
    const hasUnscoped = this.tasks.some(
      (entry) =>
        entry.owner === task.owner &&
        entry.status === "completed" &&
        (entry.scope === undefined || entry.scope.length === 0),
    );
    if (!hasUnscoped) {
      const union = this.tasks
        .filter(
          (entry) =>
            entry.owner === task.owner &&
            entry.status === "completed" &&
            entry.scope !== undefined &&
            entry.scope.length > 0,
        )
        .flatMap((entry) => entry.scope!);
      const outside = diff.files.filter((file) => !matchesAnyScope(file, union));
      if (outside.length > 0) {
        return mergeRejected(
          task.id,
          "out_of_scope_diff",
          `Branch touches files outside the completed tasks' scope: ${outside.join(", ")}. ` +
            "Widen the task scope, reassign the files, or discard the branch.",
        );
      }
    }
    const head = await runGit(this.workspaceRoot, ["rev-parse", "HEAD"]);
    if (head.ok && head.stdout.trim() !== base.base) {
      const mainDiff = await diffFiles(this.workspaceRoot, base.base, "HEAD");
      if (mainDiff.ok) {
        const overlap = diff.files.filter((file) => mainDiff.files.includes(file));
        if (overlap.length > 0) {
          return mergeRejected(
            task.id,
            "base_moved",
            `Main moved past the merge base and also touches ${overlap.join(", ")}. ` +
              "Decide the order: merge one branch, then have the teammate rebase or redo the overlapping change.",
          );
        }
      }
    }
    const merged = await mergeBranch(this.workspaceRoot, branch);
    if (!merged.ok) {
      return mergeRejected(task.id, "git_error", merged.error);
    }
    task.mergedAt = new Date().toISOString();
    await this.persistBoard();
    this.logger?.info?.("Team branch merged", {
      module: "core.agent.team",
      team: this.active.name,
      member: task.owner,
      branch,
      files: merged.mergedFiles.length,
    });
    return {
      status: "success",
      taskId: task.id,
      task: this.withBlocks(task),
      mergedFiles: merged.mergedFiles,
      message: `Merged '${branch}' into the main checkout (${merged.mergedFiles.length} file(s): ${merged.mergedFiles.slice(0, 5).join(", ")}${merged.mergedFiles.length > 5 ? ", …" : ""}).`,
    };
  }

  /**
   * 冲突检测（设计 2.6 O1 的 M2 部分）：未 merge 的 completed 任务按 owner 聚合，
   * 各自分支对 merge-base 的 diff 文件集两两求交——重叠即预警，合并前交给 lead
   * 裁决顺序。保守提示：文件重叠不等于行冲突。
   */
  private async detectMergeConflicts(): Promise<string[]> {
    if (!this.active) return [];
    const owners = new Set(
      this.tasks
        .filter((task) => task.status === "completed" && task.mergedAt === undefined && task.owner !== undefined)
        .map((task) => task.owner as string),
    );
    const entries: { owner: string; files: string[] }[] = [];
    for (const owner of owners) {
      const member = this.roster.find((entry) => entry.name === owner);
      if (member?.worktreePath === undefined) continue;
      const branch = `zcode-team/${this.active.name}/${owner}`;
      const base = await mergeBaseOf(this.workspaceRoot, branch);
      if (!base.ok) continue;
      const diff = await diffFiles(this.workspaceRoot, base.base, branch);
      if (!diff.ok || diff.files.length === 0) continue;
      entries.push({ owner, files: diff.files });
    }
    const warnings: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const overlap = entries[i].files.filter((file) => entries[j].files.includes(file));
        if (overlap.length > 0) {
          warnings.push(
            `Branches of '${entries[i].owner}' and '${entries[j].owner}' both touch ${overlap.slice(0, 5).join(", ")}${overlap.length > 5 ? ", …" : ""}; decide the merge order (team_merge one at a time).`,
          );
        }
      }
    }
    return warnings;
  }

  /**
   * 僵尸清扫（停滞检测 M1 形态 + 失败断路器，设计 2.7）：probing 失败/任务消失的成员
   * 自动除名（removeMember 顺带释放名下任务）。running/succeeded 不动——succeeded 只是
   * 上一轮跑完，仍可被唤醒。
   */
  private async sweepZombieMembers(): Promise<string[]> {
    if (!this.memberControl || !this.active) return [];
    const notes: string[] = [];
    // 同 deleteTeam：removeMember 重赋值 roster，for-of 持旧引用稳定；这里只改字段不移除。
    for (const member of this.roster) {
      if (member.agentId === undefined) continue;
      let status: Awaited<ReturnType<TeamMemberControlTarget["getAgentStatus"]>>;
      try {
        status = await this.memberControl.getAgentStatus(member.agentId);
      } catch {
        continue;
      }
      if (status !== "failed" && status !== "missing") continue;
      // M3 死亡标记（取代 M1 的除名）：任务释放 + 人与 worktree 保留。
      // failed = 进程内任务终态但注册表还在——agentId 留着，sendMessage 仍可复活；
      // missing = 注册表查无——agentId 作废，只能同名重 spawn 复活（在途消息补送）。
      const priorState = member.state;
      const released = this.releaseOwnedTasks(member.name);
      member.state = status === "missing" ? "stopped" : "failed";
      if (status === "missing") {
        member.agentId = undefined;
      }
      if (released > 0) {
        await this.persistBoard();
      }
      const changed = priorState !== member.state || released > 0;
      if (!changed) continue;
      const persistError = await this.persistRoster();
      if (persistError) {
        notes.push(`${member.name}: mark ${member.state} failed to persist (${persistError})`);
        continue;
      }
      this.logger?.warn?.("Teammate marked dead", {
        module: "core.agent.team",
        team: this.active.name,
        member: member.name,
        taskStatus: status,
        releasedTasks: released,
      });
      notes.push(
        `${member.name} marked ${member.state}${released > 0 ? `, ${released} task(s) released` : ""}; revive with team_spawn_teammate`,
      );
    }
    return notes;
  }

  private validateStatusTransition(
    caller: string,
    isLead: boolean,
    task: TeamTask,
    target: TeamTask["status"],
    ownerToSet: string | undefined,
  ): string | undefined {
    const effectiveOwner = ownerToSet ?? task.owner;
    switch (target) {
      case "in_progress": {
        if (task.status !== "pending") {
          return `Task #${task.id} is ${task.status}; only pending tasks can start.`;
        }
        const openDeps = task.blockedBy.filter((id) => {
          const dep = this.tasks.find((entry) => entry.id === id);
          return dep === undefined || !isTaskTerminal(dep.status);
        });
        if (openDeps.length > 0) {
          return `Task #${task.id} is blocked by unfinished task(s) ${openDeps.join(", ")}.`;
        }
        if (effectiveOwner === undefined) {
          // 一人一任务（设计 2.5 认领协议）：认领者手上不得有未完成的 in_progress。
          const held = this.tasks.find(
            (entry) =>
              entry.id !== task.id && entry.owner === caller && entry.status === "in_progress",
          );
          if (!isLead && held) {
            return `You already hold task #${held.id} in progress; finish or release it first (task_update status=pending).`;
          }
        } else if (!isLead && effectiveOwner !== caller) {
          return `Task #${task.id} is owned by ${effectiveOwner}; only the owner or the lead can start it.`;
        }
        return undefined;
      }
      case "completed": {
        if (task.status !== "in_progress") {
          return `Task #${task.id} is ${task.status}; move it to in_progress before completing.`;
        }
        if (!isLead && effectiveOwner !== caller) {
          return `Task #${task.id} is owned by ${effectiveOwner ?? "nobody"}; only the owner or the lead can complete it.`;
        }
        return undefined;
      }
      case "pending": {
        if (task.status !== "in_progress") {
          return "Only in_progress tasks can be released back to pending.";
        }
        if (!isLead && task.owner !== caller) {
          return `Task #${task.id} is owned by ${task.owner ?? "nobody"}; only the owner or the lead can release it.`;
        }
        return undefined;
      }
      case "cancelled": {
        if (!isLead) return "Only the lead can cancel tasks.";
        return undefined;
      }
    }
  }

  private updateMessage(before: TeamTask, task: TeamTask): string {
    const parts: string[] = [];
    if (before.status !== task.status) parts.push(`status ${before.status} → ${task.status}`);
    if (before.owner !== task.owner) {
      parts.push(task.owner === undefined ? "owner released" : `owner → ${task.owner}`);
    }
    let message = `Task #${task.id} updated (${parts.join(", ")}).`;
    // 自动认领的 M1 形态：完成回包带下一步可认领提示，由完成者自续跑（无需新唤醒机制）。
    if (task.status === "completed") {
      const claimable = this.claimableTasks().slice(0, 3);
      message +=
        claimable.length > 0
          ? ` Next claimable: ${claimable.map((entry) => `#${entry.id} '${entry.subject}'`).join("; ")}.`
          : " Nothing else is claimable right now.";
    }
    return message;
  }

  /** pending + 无主 + 依赖全终态，按 id 升序（认领协议：最低 ID 优先）。 */
  private claimableTasks(): TeamTask[] {
    return this.tasks
      .filter(
        (task) =>
          task.status === "pending" &&
          task.owner === undefined &&
          task.blockedBy.every((id) => {
            const dep = this.tasks.find((entry) => entry.id === id);
            return dep !== undefined && isTaskTerminal(dep.status);
          }),
      )
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** blocks 是 blockedBy 的反向投影，读取时派生（双写必漂移）。 */
  private withBlocks(task: TeamTask): TeamTask {
    return {
      ...task,
      blocks: this.tasks.filter((entry) => entry.blockedBy.includes(task.id)).map((entry) => entry.id),
    };
  }

  private boardView(): TeamTask[] {
    return [...this.tasks]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((task) => this.withBlocks(task));
  }

  private boardSummary(): string {
    const counts = new Map<TeamTask["status"], number>();
    for (const task of this.tasks) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    const detail = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
    return `${this.tasks.length} task(s) on the board${detail ? `: ${detail}` : ""}.`;
  }

  private taskIdHint(): string {
    const open = this.tasks
      .filter((task) => !isTaskTerminal(task.status))
      .map((task) => `#${task.id}`)
      .join(", ");
    return open.length > 0 ? open : "(none)";
  }

  /** M3 信箱写入（原 M1 镜像）：在途条目落盘即真相，失败告警不阻断应答。 */
  private async enqueueInbox(
    to: string,
    entry: Parameters<TeamStore["appendInboxMessage"]>[2],
  ): Promise<void> {
    if (!this.active) return;
    try {
      await this.store.appendInboxMessage(this.active.name, to, entry);
    } catch (error) {
      this.logger?.warn?.("Team inbox write failed", {
        module: "core.agent.team",
        team: this.active.name,
        messageId: entry.messageId,
        error: errorMessage(error),
      });
    }
  }

  private async readInboxState(member: string): Promise<TeamInboxFile> {
    if (!this.active) return { schemaVersion: 1, messages: [] };
    return this.store.readInbox(this.active.name, member);
  }

  /** 投递结局达成后标消费（best-effort；失败只在途多留一条，复活补送兜底）。 */
  private async markDelivered(member: string, ...messageIds: string[]): Promise<void> {
    if (!this.active || messageIds.length === 0) return;
    try {
      await this.store.markInboxDelivered(this.active.name, member, messageIds);
    } catch (error) {
      this.logger?.warn?.("Team inbox delivered-mark failed", {
        module: "core.agent.team",
        team: this.active.name,
        member,
        error: errorMessage(error),
      });
    }
  }

  // ============================================================
  // M3 轮询后端（设计 2.4：500ms 文件信箱轮询是跨进程/崩溃后的消费行为）
  // ============================================================

  private startInboxPolling(): void {
    if (this.inboxTimer !== undefined) return;
    this.inboxTimer = setInterval(() => void this.pollTick(), TEAM_INBOX_POLL_INTERVAL_MS);
    // 不阻止进程退出：无团队时 tick 自空转，进程退出随事件循环收尾。
    this.inboxTimer.unref?.();
  }

  private stopInboxPolling(): void {
    if (this.inboxTimer === undefined) return;
    clearInterval(this.inboxTimer);
    this.inboxTimer = undefined;
    this.injectFailureStreak = 0;
    this.idleNotified.clear();
  }

  private async pollTick(): Promise<void> {
    if (this.pollTicking || !this.active) return;
    this.pollTicking = true;
    const team = this.active.name;
    try {
      await this.pumpLeadInbox(team);
      await this.detectMemberIdle();
    } catch (error) {
      this.logger?.warn?.("Team inbox poll failed", {
        module: "core.agent.team",
        team,
        error: errorMessage(error),
      });
    } finally {
      this.pollTicking = false;
    }
  }

  /**
   * lead 信箱泵：在途消息合并成一条合成输入，经注入钩子进 lead 的活跃 turn（工具
   * 边界 steer，与成员收件同款原语）。无活跃 turn 时留在信箱下一轮再试——节流日志
   * 防刷屏。注入成功即标消费。
   */
  private async pumpLeadInbox(team: string): Promise<void> {
    if (this.leadInboxTarget === undefined) return;
    const inbox = await this.store.readInbox(team, "lead");
    const pending = inbox.messages.filter((message) => message.deliveredAt === undefined);
    if (pending.length === 0) {
      this.injectFailureStreak = 0;
      return;
    }
    const text = pending
      .map((message) => `[team inbox] ${message.from} → lead\n${message.message}`)
      .join("\n---\n");
    let injected = false;
    try {
      injected = await this.leadInboxTarget.inject(text);
    } catch (error) {
      this.logger?.warn?.("Team lead inbox inject failed", {
        module: "core.agent.team",
        team,
        error: errorMessage(error),
      });
    }
    if (!injected) {
      this.injectFailureStreak += 1;
      if (this.injectFailureStreak % 20 === 1) {
        this.logger?.info?.("Team lead inbox waiting for an active lead turn", {
          module: "core.agent.team",
          team,
          pending: pending.length,
        });
      }
      return;
    }
    this.injectFailureStreak = 0;
    await this.markDelivered("lead", ...pending.map((message) => message.messageId));
  }

  /**
   * run 级 TeammateIdle 精确触发（PR9 注记的补课）：成员任务收束（succeeded——上一轮
   * 跑完可复活）且名下无 in_progress、看板无可认领任务 → 通知一次；任务重新 running
   * 即清零去重。failed/missing 不算 idle（那是死亡/治理信号，清扫归 collect 入口）。
   */
  private async detectMemberIdle(): Promise<void> {
    if (!this.active || this.memberControl === undefined) return;
    for (const member of this.roster) {
      if (member.agentId === undefined || member.state === "spawning") continue;
      let status: Awaited<ReturnType<TeamMemberControlTarget["getAgentStatus"]>>;
      try {
        status = await this.memberControl.getAgentStatus(member.agentId);
      } catch {
        continue;
      }
      if (status === "running") {
        this.idleNotified.delete(member.name);
        continue;
      }
      if (status !== "succeeded" || this.idleNotified.has(member.name)) continue;
      const holdsTask = this.tasks.some(
        (task) => task.owner === member.name && task.status === "in_progress",
      );
      if (holdsTask || this.claimableTasks().length > 0) continue;
      this.fireTeammateIdleOnce(member.name);
    }
  }

  /**
   * TeammateIdle 统一去重点（M3）：updateTask 完成路径、spawn 就绪路径与轮询器三处
   * 共用——同一次空闲收束只通知一次；成员任务重新 running 时由轮询器清零。
   * spawn 就绪路径是「新收束」，调用前先 delete 再直接 notifyTeamHook。
   */
  private fireTeammateIdleOnce(memberName: string): void {
    if (!this.active || this.idleNotified.has(memberName)) return;
    this.idleNotified.add(memberName);
    this.notifyTeamHook({
      hookEventName: "TeammateIdle",
      memberName,
      teamName: this.active.name,
    });
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

  /**
   * 看板镜像 best-effort（区别于 roster 的硬失败语义）：board.json 在 M1 没有任何读方
   * （接管是 M3），内存是唯一真相；落盘失败仅告警，不回滚业务变更。
   */
  private async persistBoard(): Promise<void> {
    if (!this.active) return;
    try {
      await this.store.writeBoard(this.active.name, {
        schemaVersion: 1,
        nextId: this.nextTaskId,
        tasks: this.tasks,
      });
    } catch (error) {
      this.logger?.warn?.("Team board mirror write failed", {
        module: "core.agent.team",
        team: this.active.name,
        error: errorMessage(error),
      });
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
 * 无团队时各操作快速失败。from/身份由闭包绑定，模型不可谎报。
 */
export function createLeadTeamPort(manager: TeamManager): LeadTeamPort {
  return {
    send: (to, request) => manager.route("lead", to, request),
    listTasks: () => manager.listTasks(),
    queryTask: (request) => manager.queryTask(request),
    updateTask: (request) => manager.updateTask("lead", request),
    createTeam: (request) => manager.createTeam(request),
    deleteTeam: (request) => manager.deleteTeam(request),
    reserveMember: (registration) => manager.reserveMember(registration),
    completeMemberSpawn: (memberName, agent) => manager.completeMemberSpawn(memberName, agent),
    removeMember: (memberName, reason) => manager.removeMember(memberName, reason),
    createMemberPort: (memberName) => createMemberTeamPort(manager, memberName),
    setupMemberWorkspace: (memberName) => manager.setupMemberWorkspace(memberName),
    getMemberWritePolicy: (memberName) => manager.getMemberWritePolicy(memberName),
    createTask: (request) => manager.createTask(request),
    mergeTask: (request) => manager.mergeTask(request),
    collectTasks: (request, signal) => manager.collectTasks(request, signal),
    adoptTeam: (request) => manager.adoptTeam(request),
    readMemberPendingMessages: (memberName) => manager.readMemberPendingMessages(memberName),
    markMemberMessagesDelivered: (memberName, messageIds) =>
      manager.markMemberMessagesDelivered(memberName, messageIds),
  };
}

/** 成员窄面端口（注入缝用）：identity 同样闭包绑定；看板只能读 + 动自己的任务。 */
export function createMemberTeamPort(manager: TeamManager, memberName: string): TeamPort {
  return {
    send: (to, request) => manager.route(memberName, to, request),
    listTasks: () => manager.listTasks(),
    queryTask: (request) => manager.queryTask(request),
    updateTask: (request) => manager.updateTask(memberName, request),
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

function workspaceFailed(reason: string): TeamMemberWorkspaceResult {
  return { status: "failed", message: reason, error: reason };
}

/** merge gate 拒绝：rejection 机器码 + message 兼作 error（人读指引）。 */
function mergeRejected(
  taskId: string | undefined,
  rejection: TeamMergeRejection | undefined,
  reason: string,
): TeamMergeResult {
  return {
    status: "failed",
    ...(taskId !== undefined ? { taskId } : {}),
    ...(rejection !== undefined ? { rejection } : {}),
    message: reason,
    error: reason,
  };
}

function sendFailed(reason: string): TeamSendResult {
  return { status: "failed", messageId: `teammsg_${randomUUID()}`, message: "Message was not delivered.", error: reason };
}

function adoptFailed(reason: string): TeamAdoptResult {
  return { status: "failed", message: reason, error: reason };
}

function taskFailed(
  reason: string,
): TeamTaskCreateResult & TeamTaskUpdateResult & TeamTaskQueryResult {
  return { status: "failed", message: reason, error: reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
