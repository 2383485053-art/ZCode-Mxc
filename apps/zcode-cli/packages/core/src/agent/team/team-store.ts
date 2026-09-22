import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TEAM_BOARD_FILE_SCHEMA,
  TEAM_CONFIG_FILE_SCHEMA,
  TEAM_INBOX_FILE_SCHEMA,
  type TeamBoardFile,
  type TeamConfigFile,
  type TeamInboxFile,
} from "@zcode/contracts";

const ARCHIVE_DIR_NAME = ".archive";
const TEAM_SUBDIRS = ["inboxes", "contracts", "worklogs"] as const;
/** Windows 上成员子进程/git 句柄异步释放，归档 rename 可能首试 EBUSY/EPERM——重试即过。 */
const ARCHIVE_RENAME_RETRIES = 3;
const ARCHIVE_RETRY_DELAY_MS = 300;

export class TeamStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "name_taken"
      | "config_invalid"
      | "not_found"
      | "generation_mismatch"
      | "io_error",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TeamStoreError";
  }
}

export interface TeamStoreLocation {
  teamDir: string;
  configPath: string;
  boardPath: string;
  inboxPath(member: string): string;
}

/** 文件即真相（设计 2.3）：home 侧统一根，跟 saved-workflows 同款 os.homedir 决策，不跟 storage.dir。 */
export class TeamStore {
  private readonly teamsRoot: string;

  constructor(homeDir: string = homedir()) {
    this.teamsRoot = join(homeDir, ".zcode", "teams");
  }

  get root(): string {
    return this.teamsRoot;
  }

  location(teamName: string): TeamStoreLocation {
    const teamDir = join(this.teamsRoot, teamName);
    return {
      teamDir,
      configPath: join(teamDir, "config.json"),
      boardPath: join(teamDir, "board.json"),
      inboxPath: (member) => join(teamDir, "inboxes", `${member}.json`),
    };
  }

  async listTeamNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.teamsRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && entry.name !== ARCHIVE_DIR_NAME)
        .map((entry) => entry.name);
    } catch (error) {
      // 根目录不存在 = 从未建过团队，不是错误。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new TeamStoreError(`Cannot list teams under ${this.teamsRoot}`, "io_error", error);
    }
  }

  async readConfig(teamName: string): Promise<TeamConfigFile> {
    const { configPath } = this.location(teamName);
    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TeamStoreError(`Team '${teamName}' has no config.json`, "not_found", error);
      }
      throw new TeamStoreError(`Cannot read ${configPath}`, "io_error", error);
    }
    const parsed = TEAM_CONFIG_FILE_SCHEMA.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // 损坏文件按设计 2.8 隔离：报具体原因交上层决策，不传染其他团队。
      throw new TeamStoreError(
        `Team '${teamName}' config.json is invalid: ${parsed.error.message}`,
        "config_invalid",
      );
    }
    return parsed.data;
  }

  /**
   * wx 语义防重名：父目录 recursive 允许已存在，团队目录本身一次成型——
   * 已存在即 EEXIST，不存在两个进程同时建同名成功的窗口（设计 2.3）。
   */
  async createTeamDir(teamName: string, config: TeamConfigFile): Promise<void> {
    const { teamDir, configPath } = this.location(teamName);
    await mkdir(this.teamsRoot, { recursive: true });
    try {
      await mkdir(teamDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new TeamStoreError(`Team name '${teamName}' already exists`, "name_taken", error);
      }
      throw error;
    }
    for (const sub of TEAM_SUBDIRS) {
      await mkdir(join(teamDir, sub));
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  /** roster 变更的落盘通道（读-改-写；单团队单 lead 写者，无并发写者竞争）。 */
  async writeConfig(teamName: string, config: TeamConfigFile): Promise<void> {
    const { configPath } = this.location(teamName);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  /** 看板落盘（内存态是真相，board.json 是镜像；nextId 即水位，M1 单写者）。 */
  async writeBoard(teamName: string, board: TeamBoardFile): Promise<void> {
    const { boardPath } = this.location(teamName);
    const parsed = TEAM_BOARD_FILE_SCHEMA.parse(board);
    // 落盘形状去派生字段（blocks 读取时派生，双写必漂移）。
    const tasks = parsed.tasks.map(({ blocks: _blocks, ...task }) => task);
    await writeFile(
      boardPath,
      `${JSON.stringify({ ...parsed, tasks }, null, 2)}\n`,
      "utf8",
    );
  }

  async appendInboxMessage(
    teamName: string,
    member: string,
    entry: TeamInboxFile["messages"][number],
  ): Promise<void> {
    const path = this.location(teamName).inboxPath(member);
    let inbox: TeamInboxFile = { schemaVersion: 1, messages: [] };
    try {
      inbox = TEAM_INBOX_FILE_SCHEMA.parse(JSON.parse(await readFile(path, "utf8")));
    } catch {
      // 文件不存在 = 首条消息；已存在但损坏 = 重置镜像。进程内事件总线才是 M1 的消费方
      // （设计 2.3），镜像重置不丢消息本体，只丢历史镜像。
    }
    inbox.messages.push(entry);
    if (inbox.messages.length > 50) {
      // 与投递队列同一条 50 上限（设计 2.4），镜像侧同步截尾防无界增长。
      inbox.messages = inbox.messages.slice(-50);
    }
    await writeFile(path, `${JSON.stringify(inbox, null, 2)}\n`, "utf8");
  }

  /**
   * worklog 落盘（M2 兑现 createTask 写下的路径承诺）：任务终态时写骨架，
   * best-effort——调用方（TeamManager）只告警不阻断。
   */
  async writeWorklog(teamName: string, taskId: string, content: string): Promise<void> {
    const { teamDir } = this.location(teamName);
    await writeFile(join(teamDir, "worklogs", `${taskId}.md`), content, "utf8");
  }

  /** 归档即删除（设计 2.5 第 4 步）：移出活跃命名空间，完整保留在 .archive/ 供事后排查。 */
  async archiveTeam(teamName: string): Promise<string> {
    const { teamDir } = this.location(teamName);
    const archiveRoot = join(this.teamsRoot, ARCHIVE_DIR_NAME);
    await mkdir(archiveRoot, { recursive: true });
    const archivedPath = join(archiveRoot, `${teamName}-${Date.now()}`);
    let lastError: unknown;
    for (let attempt = 0; attempt < ARCHIVE_RENAME_RETRIES; attempt++) {
      try {
        await rename(teamDir, archivedPath);
        return archivedPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new TeamStoreError(`Team '${teamName}' not found`, "not_found", error);
        }
        lastError = error;
        // EBUSY/EPERM/ENOTEMPTY 类句柄未释放：短暂等待后重试（真机验收遗留①）。
        if (attempt < ARCHIVE_RENAME_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, ARCHIVE_RETRY_DELAY_MS));
        }
      }
    }
    throw new TeamStoreError(`Cannot archive ${teamDir}`, "io_error", lastError);
  }

  /** 兜底清理：归档意外失败时的最后手段，直接删除。 */
  async removeTeam(teamName: string): Promise<void> {
    const { teamDir } = this.location(teamName);
    await rm(teamDir, { recursive: true, force: true });
  }
}

/** Windows/Linux 同语义的 pid 活性探测（设计 2.8）：活着不抛错；目标不存在抛 ESRCH；EPERM=存在但无权限。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
