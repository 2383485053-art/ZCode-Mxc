import type { ExecutionPort } from "@zcode/contracts";

/** 设计 2.7 O4：build/test/安装类命令全团队并发 ≤2，排队——「编辑便宜，执行才是瓶颈」。 */
export const TEAM_EXECUTION_CONCURRENCY_LIMIT = 2;

/**
 * 团队级执行信号量：只包 `run`（前台同步执行，Bash 主路径）。`start` 是后台任务，
 * 自带生命周期与并发治理（backgroundBashMaxMs 等），gate 它会让长跑后台任务占满
 * 槽位饿死前台。其余成员原样透传，显式委托防 `this` 绑定漂移。
 */
export function createTeamExecutionGate(port: ExecutionPort): ExecutionPort {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < TEAM_EXECUTION_CONCURRENCY_LIMIT) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
  };
  const gate: ExecutionPort = {
    run: async (request, options) => {
      await acquire();
      try {
        return await port.run(request, options);
      } finally {
        release();
      }
    },
  };
  // 可选成员原样透传（bind 防实现侧 this 依赖）。
  if (port.start !== undefined) gate.start = port.start.bind(port);
  if (port.getBackgroundTask !== undefined) {
    gate.getBackgroundTask = port.getBackgroundTask.bind(port);
  }
  if (port.readBackgroundBashOutput !== undefined) {
    gate.readBackgroundBashOutput = port.readBackgroundBashOutput.bind(port);
  }
  if (port.cancelBackgroundTask !== undefined) {
    gate.cancelBackgroundTask = port.cancelBackgroundTask.bind(port);
  }
  if (port.close !== undefined) gate.close = port.close.bind(port);
  return gate;
}

const teamExecutionGates = new WeakMap<object, WeakMap<ExecutionPort, ExecutionPort>>();

/**
 * 同一 lead 句柄 + 同一 executionPort 共享一个闸门（成员间才有「全团队并发 ≤2」可言）。
 * 以 WeakMap 挂在 lead 端口对象上，随 lead 生命周期回收，不引入全局单例。
 */
export function getTeamExecutionGate(
  leadPort: object,
  port: ExecutionPort,
): ExecutionPort {
  let byPort = teamExecutionGates.get(leadPort);
  if (byPort === undefined) {
    byPort = new WeakMap<ExecutionPort, ExecutionPort>();
    teamExecutionGates.set(leadPort, byPort);
  }
  let gate = byPort.get(port);
  if (gate === undefined) {
    gate = createTeamExecutionGate(port);
    byPort.set(port, gate);
  }
  return gate;
}
