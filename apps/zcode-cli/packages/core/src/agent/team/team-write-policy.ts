// ============================================================
// Agent Teams 写策略 gate（M2 隔离层：越界硬 veto 带指引）
// ============================================================

import { resolve, sep } from "node:path";
import {
  CoreErrorType,
  createCoreError,
  type FileSystemPort,
  type LeadTeamPort,
  type TeamMemberWritePolicy,
} from "@zcode/contracts";

/**
 * 注入缝的 provider 铸造：lead 端口的类型收窄发生在构造期（三元条件立即求值），
 * 闭包持有已收窄的参数——避开 TS 对闭包捕获属性不保持 narrow 的限制。
 */
export function createMemberWritePolicyProvider(
  lead: LeadTeamPort,
  memberName: string,
): () => TeamMemberWritePolicy {
  return () => lead.getMemberWritePolicy(memberName);
}

/**
 * 包住成员 child 的 fileSystemPort：写类调用（writeTextFile/removeFile/
 * createDirectory）先过 worktree 边界 + 当前任务 scope 双重校验，越界即硬 veto
 * 并给下一步指引；读类调用原样透传。policy.worktreePath 缺席（readOnly 成员/
 * 普通 spawn/成员已不在名册）时整体透传——端口即门，无树不设防。
 *
 * 与 O4 执行闸门同一条注入缝（subagent.ts child deps），scope 取的是每次调用
 * 时的最新快照（认领动态变化）。
 */
export function createTeamFileSystemGate(
  port: FileSystemPort,
  provider: () => TeamMemberWritePolicy,
): FileSystemPort {
  const assertWritable = (rawPath: string): void => {
    const policy = provider();
    if (policy.worktreePath === undefined) return;
    const worktree = resolve(policy.worktreePath);
    const target = resolve(rawPath);
    if (!isInsideDirectory(target, worktree)) {
      throw veto(
        `Teammate file writes are limited to your own worktree. '${rawPath}' is outside '${worktree}'. ` +
          "Work inside your worktree (relative paths are fine); the lead merges your branch.",
      );
    }
    if (policy.scope !== undefined && policy.scope.length > 0) {
      const rel = relativePosix(worktree, target);
      if (!matchesAnyScope(rel, policy.scope)) {
        throw veto(
          `'${rel}' is outside your current task scope [${policy.scope.join(", ")}]. ` +
            "Ask the lead to widen the task scope or reassign the file; out-of-scope changes would be rejected at merge anyway.",
        );
      }
    }
  };

  return {
    ...port,
    writeTextFile: (request, options) => {
      assertWritable(request.path);
      return port.writeTextFile(request, options);
    },
    removeFile: (request, options) => {
      assertWritable(request.path);
      return port.removeFile(request, options);
    },
    createDirectory: (request, options) => {
      assertWritable(request.path);
      return port.createDirectory(request, options);
    },
  };
}

/** 目录包含判定：路径边界（防 /foo 误含 /foobar）+ Windows 大小写不敏感。 */
function isInsideDirectory(target: string, directory: string): boolean {
  const fold = (path: string): string =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const t = fold(target);
  const d = fold(directory);
  return t === d || t.startsWith(d.endsWith(sep) ? d : d + sep);
}

function relativePosix(from: string, to: string): string {
  const rel = resolve(to).slice(resolve(from).length);
  const trimmed = rel.replace(/^[\\/]+/, "");
  return trimmed.split(sep).join("/");
}

/**
 * scope glob 匹配（仓库相对、/ 分隔）：`**` 跨目录任意段，`*`/`?` 段内通配。
 * 目录型 scope（src/auth/**）同时覆盖目录自身与其下所有内容。
 */
export function matchesAnyScope(repoRelativePath: string, scopes: string[]): boolean {
  return scopes.some((scope) => globMatches(scope, repoRelativePath));
}

export function globMatches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) =>
      segment === "**"
        ? "(?:[^/]+/)*[^/]*"
        : segment
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]"),
    )
    .join("/");
  return new RegExp(`^(?:${source})(?:/.*)?$`);
}

function veto(reason: string): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, reason, { recoverable: true });
}
