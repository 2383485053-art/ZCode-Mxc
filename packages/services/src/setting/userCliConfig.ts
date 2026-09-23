import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentTeamsConfig } from "./setting.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import { atomicWriteText } from "../fs/atomicFileUtils.js";

const DEFAULT_MAX_TEAMMATES = 5;
const MAX_TEAMMATES_LIMIT = 16;

function resolveUserHomeDir() {
  // 与 settingService/commandsService 同源的 home 解析：独立桌面 Dev 实例通过
  // ZCODE_DESKTOP_HOME_DIR 覆盖 home，各模块按当前环境解析，避免串写真实用户目录。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getUserCliConfigFile() {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读 cli/config.json 整文件。缺文件等同空配置；存在但损坏返回 null——读走默认，写要拒绝，防止覆盖丢配置。 */
async function readUserCliConfigRecord(): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(getUserCliConfigFile(), "utf-8"));
    return isJsonObject(parsed) ? parsed : null;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return {};
    }
    return null;
  }
}

async function readAgentTeamsConfig(): Promise<AgentTeamsConfig> {
  const config = await readUserCliConfigRecord();
  const features = config && isJsonObject(config.features) ? config.features : {};
  const team = config && isJsonObject(config.team) ? config.team : {};
  return {
    enabled: features.agentTeams === true,
    maxTeammates:
      typeof team.maxTeammates === "number" && Number.isInteger(team.maxTeammates)
        ? team.maxTeammates
        : DEFAULT_MAX_TEAMMATES,
  };
}

export async function getAgentTeamsConfig(): Promise<AgentTeamsConfig> {
  return readAgentTeamsConfig();
}

export async function updateAgentTeamsConfig(
  patch: Partial<AgentTeamsConfig>,
): Promise<AgentTeamsConfig> {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw new Error("agentTeams.enabled must be a boolean");
  }
  if (
    patch.maxTeammates !== undefined &&
    (!Number.isInteger(patch.maxTeammates) ||
      patch.maxTeammates < 1 ||
      patch.maxTeammates > MAX_TEAMMATES_LIMIT)
  ) {
    throw new Error(
      `agentTeams.maxTeammates must be an integer in [1, ${MAX_TEAMMATES_LIMIT}]`,
    );
  }
  const config = await readUserCliConfigRecord();
  if (config === null) {
    throw new Error(
      "cli/config.json is not valid JSON; fix or remove it before changing Agent Teams settings",
    );
  }
  const features = isJsonObject(config.features) ? { ...config.features } : {};
  const team = isJsonObject(config.team) ? { ...config.team } : {};
  if (patch.enabled !== undefined) features.agentTeams = patch.enabled;
  if (patch.maxTeammates !== undefined) team.maxTeammates = patch.maxTeammates;
  const configFile = getUserCliConfigFile();
  maybeThrowInjectedFsFault({ operation: "writeFile", path: configFile });
  await atomicWriteText(configFile, `${JSON.stringify({ ...config, features, team }, null, 2)}\n`);
  return readAgentTeamsConfig();
}
