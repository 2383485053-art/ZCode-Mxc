// ============================================================
// Agent Teams git 执行器（M2 隔离层）
// ============================================================

import { execFile } from "node:child_process";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const GIT_TIMEOUT_MS = 20_000;
/** Windows 上 stopAgent 后子进程句柄异步释放，首个 remove/prune 可能 EBUSY——重试即过。 */
const WINDOWS_HANDLE_RETRIES = 3;
const HANDLE_RETRY_DELAY_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // git 用非零退出码表达正常拒绝（如 nothing to commit）；error.code 运行时
        // 是退出码（number）或 spawn 失败码（string，如 ENOENT），两者都算 !ok，
        // stdout/stderr 始终可判别。
        const exitCode = (error as { code?: string | number } | null)?.code;
        resolve({
          ok: exitCode === undefined,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });
}

function describeGitFailure(result: GitCommandResult, what: string): string {
  const detail = result.stderr.trim() || result.stdout.trim() || "git exited non-zero";
  return `${what}: ${detail}`;
}

/** 非 git 仓库里 writer 成员无树可建——如实失败，调用方回滚 roster 并报给 lead。 */
export async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

/** 建成员 worktree（git worktree add -b <branch> <path>，基于仓库当前 HEAD）。 */
export async function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath]);
  return result.ok ? { ok: true } : { ok: false, error: describeGitFailure(result, "git worktree add failed") };
}

/** 成员在 worktree 里是否有未提交改动（status --porcelain 非空即脏）。 */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const result = await runGit(worktreePath, ["status", "--porcelain"]);
  return result.ok && result.stdout.trim().length > 0;
}

/** 任务完成时的系统代提交：成员不用管 git，merge gate 只面对干净的树。 */
export async function commitAll(
  worktreePath: string,
  message: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const add = await runGit(worktreePath, ["add", "-A"]);
  if (!add.ok) return { ok: false, error: describeGitFailure(add, "git add failed") };
  // 代提交是工具行为不是作者行为：自带身份，不依赖环境 git config（否则无
  // user.email 的机器上每个任务都完成不了）。
  const commit = await runGit(worktreePath, [
    "-c",
    "user.name=zcode-team",
    "-c",
    "user.email=team@zcode.local",
    "commit",
    "-m",
    message,
  ]);
  // nothing to commit 不是失败：任务没改文件（纯调研/评审）同样算完成。
  if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    return { ok: false, error: describeGitFailure(commit, "git commit failed") };
  }
  return { ok: true };
}

/**
 * 回收成员 worktree：remove --force + prune（后者清掉 .git/worktrees 里的悬挂登记）。
 * Windows 句柄延迟释放（真机验收遗留①）：ENOTEMPTY/EBUSY 类失败短暂重试。
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let lastError = "";
  for (let attempt = 0; attempt < WINDOWS_HANDLE_RETRIES; attempt++) {
    const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    if (removed.ok) {
      await runGit(repoRoot, ["worktree", "prune"]);
      return { ok: true };
    }
    lastError = describeGitFailure(removed, "git worktree remove failed");
    if (attempt < WINDOWS_HANDLE_RETRIES - 1) await delay(HANDLE_RETRY_DELAY_MS);
  }
  // 目录已不在（手动清理过）时 prune 掉登记即算回收完成。
  const exists = await runGit(worktreePath, ["rev-parse", "--is-inside-work-tree"]).then(
    (result) => result.ok,
  );
  if (!exists) {
    await runGit(repoRoot, ["worktree", "prune"]);
    return { ok: true };
  }
  return { ok: false, error: lastError };
}

// ============================================================
// merge gate（M2 PR8）
// ============================================================

/** 两分支的 merge-base（在 repoRoot 跑，HEAD 即主 checkout 当前分支）。 */
export async function mergeBaseOf(
  repoRoot: string,
  branch: string,
): Promise<{ ok: true; base: string } | { ok: false; error: string }> {
  const result = await runGit(repoRoot, ["merge-base", "HEAD", branch]);
  return result.ok
    ? { ok: true, base: result.stdout.trim() }
    : { ok: false, error: describeGitFailure(result, "git merge-base failed") };
}

/** 分支相对 base 的改动文件集（仓库相对路径，\n 分隔）。 */
export async function diffFiles(
  repoRoot: string,
  base: string,
  branch: string,
): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  const result = await runGit(repoRoot, ["diff", "--name-only", `${base}...${branch}`]);
  return result.ok
    ? {
        ok: true,
        files: result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      }
    : { ok: false, error: describeGitFailure(result, "git diff failed") };
}

/** 主 checkout 脏检查（lead 自己的未提交改动会让 merge 无法收场）。 */
export async function isCheckoutDirty(repoRoot: string): Promise<boolean> {
  const result = await runGit(repoRoot, ["status", "--porcelain"]);
  return result.ok && result.stdout.trim().length > 0;
}

/**
 * merge 成员分支进主 checkout 当前分支。冲突即 abort 回滚（worktree 复位，
 * 设计 2.6 O8 的 merge 失败半边）并如实报错——main 停在 merge 前状态。
 */
export async function mergeBranch(
  repoRoot: string,
  branch: string,
): Promise<{ ok: true; mergedFiles: string[] } | { ok: false; error: string }> {
  const merged = await runGit(repoRoot, [
    "-c",
    "user.name=zcode-team",
    "-c",
    "user.email=team@zcode.local",
    "merge",
    "--no-edit",
    "--no-ff",
    branch,
  ]);
  if (!merged.ok) {
    await runGit(repoRoot, ["merge", "--abort"]);
    return { ok: false, error: describeGitFailure(merged, "git merge failed (rolled back)") };
  }
  const files = await runGit(repoRoot, ["diff", "--name-only", "HEAD~1..HEAD"]);
  return {
    ok: true,
    mergedFiles: files.ok
      ? files.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [],
  };
}
