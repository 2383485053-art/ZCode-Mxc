/* eslint-disable max-lines -- TeamManager 集中承载团队生命周期/名册/投递路由/看板状态机与 ACL，
   单 writer 单进程的 M1 边界先在这里稳定（roster/看板/投递共享同一份内存真相与落盘节奏），
   M2/M3 引入跨进程与 hooks 时再按职责拆分。 */
import { randomUUID } from "node:crypto";
import type {
  LeadTeamPort,
  Logger,
  TeamCollectRequest,
  TeamCollectResult,
  TeamCreateRequest,
  TeamCreateResult,
  TeamDeleteRequest,
  TeamDeleteResult,
  TeamDeliveryTarget,
  TeamMember,
  TeamMemberControlTarget,
  TeamMemberRegistration,
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
import { isPidAlive, TeamStore, TeamStoreError } from "./team-store.js";

/** 成员默认上限（设计 2.3 的 3-5 甜点）；settings 键 team.maxTeammates 随治理层 PR 接入。 */
const DEFAULT_MAX_TEAMMATES = 5;

const COLLECT_POLL_INTERVAL_MS = 500;

/** 终态判定：completed/cancelled 之后看板条目不可再改（设计 2.5）。 */
function isTaskTerminal(status: TeamTask["status"]): boolean {
  return status === "completed" || status === "cancelled";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TeamManager（M1 全量：实体 + roster + 投递 + 看板 + 治理）：团队生命周期、成员名册、
 * 进程内路由与唤醒、共享任务板、关机编排与僵尸清扫。挂在 lead 的 app 装配里，随主会话
 * 存续；跨进程互斥由磁盘上的 leadPid 活性判定兜底。
 *
 * 投递（通信层下半场）：成员收件经装配的 TeamDeliveryTarget 送进 lead 进程的子代理任务
 * 注册表——busy 成员 steer 进活跃 turn，idle 成员带消息后台复活；lead 收件恒 queued
 * （主会话无任务可 steer，镜像即全部）。
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

  constructor(
    private readonly store: TeamStore,
    private readonly leadSessionId: string,
    private readonly logger?: Logger,
    private readonly maxTeammates: number = DEFAULT_MAX_TEAMMATES,
  ) {}

  /** 装配期挂投递钩子（bootstrap 在 AgentRuntime 构造后回填 lead 侧 subagent 端口）。 */
  attachDeliveryTarget(target: TeamDeliveryTarget | undefined): void {
    this.deliveryTarget = target;
  }

  /** 装配期挂成员控制钩子（同一端口）：关机停任务 + 僵尸清扫探测。 */
  attachMemberControl(control: TeamMemberControlTarget | undefined): void {
    this.memberControl = control;
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

  /**
   * 路由（实体层 + 投递）：roster 白名单校验 → 投递（成员收件 steer/复活，lead 收件入队）
   * → 持久化镜像。每条消息必有明确结局（送达/入队/拒绝，设计 2.4）。
   * peer 点对点投递自动向 lead 信箱写一行摘要（cc-lead，设计 2.4：lead 对网状对话保持可见）。
   */
  async route(from: string, to: string, request: TeamSendMessage): Promise<TeamSendResult> {
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
    // lead 收件：无任务可 steer，入队即结局；成员收件：必须等到 steer/复活的实际结局。
    if (to === "lead") {
      void this.mirrorAppend(to, entry);
      return {
        status: "success",
        messageId,
        message: `Message queued for lead.`,
        delivery: "queued",
      };
    }
    if (!this.deliveryTarget) {
      return sendFailed(
        messageId,
        `Teammate '${to}' cannot receive messages: delivery is unavailable (subagents disabled?).`,
      );
    }
    const delivered = await this.deliveryTarget.sendMessage(to, {
      summary: request.summary,
      message: request.message,
      trace: request.trace,
    });
    if (delivered.status === "failed") {
      return sendFailed(
        messageId,
        `Delivery to teammate '${to}' failed: ${delivered.error ?? delivered.message ?? "unknown error"}`,
      );
    }
    // 镜像写入是 async 的，投递结局达成后 fire-and-forget + 失败日志：镜像丢失不回滚应答。
    void this.mirrorAppend(to, entry);
    if (from !== "lead") {
      void this.mirrorAppend("lead", {
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
        delivery === "resumed_background"
          ? `Teammate '${to}' was idle; resumed in the background with your message.`
          : delivery === "steered"
            ? `Message delivered into the active turn of teammate '${to}'.`
            : `Message queued for ${to}.`,
      delivery,
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
    await this.persistBoard();
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
      swept.length > 0 ? ` Released stalled member(s): ${swept.join(", ")}.` : "";
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
    return { status, tasks: this.boardView(), message };
  }

  /**
   * 僵尸清扫（停滞检测 M1 形态 + 失败断路器，设计 2.7）：probing 失败/任务消失的成员
   * 自动除名（removeMember 顺带释放名下任务）。running/succeeded 不动——succeeded 只是
   * 上一轮跑完，仍可被唤醒。
   */
  private async sweepZombieMembers(): Promise<string[]> {
    if (!this.memberControl || !this.active) return [];
    const removed: string[] = [];
    // 同 deleteTeam：removeMember 重赋值 roster，for-of 持旧引用稳定。
    for (const member of this.roster) {
      if (member.agentId === undefined) continue;
      let status: Awaited<ReturnType<TeamMemberControlTarget["getAgentStatus"]>>;
      try {
        status = await this.memberControl.getAgentStatus(member.agentId);
      } catch {
        continue;
      }
      if (status === "failed" || status === "missing") {
        const result = await this.removeMember(member.name, `member task ${status} (zombie sweep)`);
        if (result.status === "success") {
          removed.push(member.name);
          this.logger?.warn?.("Zombie teammate swept", {
            module: "core.agent.team",
            team: this.active.name,
            member: member.name,
            agentId: member.agentId,
            taskStatus: status,
          });
        }
      }
    }
    return removed;
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
    createTask: (request) => manager.createTask(request),
    collectTasks: (request, signal) => manager.collectTasks(request, signal),
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

function sendFailed(messageId: string, reason: string): TeamSendResult {
  return { status: "failed", messageId, message: "Message was not delivered.", error: reason };
}

function taskFailed(
  reason: string,
): TeamTaskCreateResult & TeamTaskUpdateResult & TeamTaskQueryResult {
  return { status: "failed", message: reason, error: reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
