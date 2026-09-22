// ============================================================
// Agent exports
// ============================================================

export * from "./turn-state.js";
export * from "./turn-machine.js";
export { MessageHistoryImpl, createMessageHistory } from "./message-history.js";
export {
  activeSessionMessages,
  hydrateMessageHistoryFromSession,
} from "./session-history-hydrator.js";
export type {
  MessageHistory,
  ModelInputMessage,
  ToolCallInput,
  CacheStats,
} from "./message-history.js";
export type { SessionHistoryHydrationResult } from "./session-history-hydrator.js";
// Agent Teams（M1 实体层）：TeamManager 与 lead/member 端口工厂。
export * from "./team/index.js";
