import type { AppSettings } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 智能体团队用户级配置。事实源是 ~/.zcode/cli/config.json 的 features.agentTeams 与 team.maxTeammates，CLI 运行时从同一文件读取。 */
export interface AgentTeamsConfig {
  enabled: boolean;
  maxTeammates: number;
}

export interface ISettingService {
  get(): Promise<AppSettings>;
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      "providerFamilyDomain" | "providerFamilyConnectionSelections"
    >,
  ): Promise<void>;
  /** Change the data base directory: copy data from old → new location, then persist the setting. */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  ensureDefaultProject(homedir: string): Promise<{ path: string; created: boolean }>;
  /** 缺省 enabled=false、maxTeammates=5，与 CLI 内置默认一致；文件缺失不算错误。 */
  getAgentTeamsConfig(): Promise<AgentTeamsConfig>;
  /** 保存到 cli/config.json；文件存在但不是合法 JSON 时抛错，避免整文件覆盖丢掉手工配置。 */
  updateAgentTeamsConfig(patch: Partial<AgentTeamsConfig>): Promise<AgentTeamsConfig>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);
