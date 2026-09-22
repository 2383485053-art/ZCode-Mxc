import type { SubagentPort, TeamMemberControlTarget } from "@zcode/contracts";

/**
 * 成员控制适配器：lead 侧 subagent 端口 → TeamMemberControlTarget。
 * stopAgent 用于关机（停不掉只记日志，删除继续——成员迟到的 team_send 会被
 * 「No active team」白名单挡住）；getAgentStatus 用于僵尸清扫。
 */
export function createSubagentTeamControl(port: SubagentPort): TeamMemberControlTarget {
  return {
    stopAgent: async (agentId) => {
      await port.stopTask?.(agentId);
    },
    getAgentStatus: async (agentId) => {
      const task = await port.getTask?.(agentId);
      if (task === undefined) return "missing";
      if (task.status === "running") return "running";
      // 死而不雅的终态（failed/cancelled/killed/lost）算僵尸；completed/stopped 只是
      // 上一轮跑完，仍可被唤醒复活。
      switch (task.status) {
        case "failed":
        case "cancelled":
        case "killed":
        case "lost":
          return "failed";
        default:
          return "succeeded";
      }
    },
  };
}
