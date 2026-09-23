import { useCallback, useEffect, useState } from "react";
import type { AgentTeamsConfig } from "@zcode/services";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

const MAX_TEAMMATES_LIMIT = 16;

export function AgentTeamsSection() {
  const { settingService } = useServices();
  const { intl } = useZCodeIntl();
  // undefined=加载中，null=读取失败。
  const [config, setConfig] = useState<AgentTeamsConfig | null | undefined>(undefined);
  const [maxTeammatesDraft, setMaxTeammatesDraft] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await settingService.getAgentTeamsConfig();
      setConfig(next);
      setMaxTeammatesDraft(String(next.maxTeammates));
    } catch (error) {
      logger.warn("[AgentTeamsSection] 读取配置失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setConfig(null);
    }
  }, [settingService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleEnabledChange = useCallback(
    async (enabled: boolean) => {
      const previous = config;
      if (!previous) return;
      setConfig({ ...previous, enabled });
      try {
        setConfig(await settingService.updateAgentTeamsConfig({ enabled }));
      } catch (error) {
        logger.warn("[AgentTeamsSection] 保存开关失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        setConfig(previous);
        toast(intl.formatMessage({ id: "settings.agentTeams.updateFailed" }));
      }
    },
    [config, intl, settingService],
  );

  const commitMaxTeammates = useCallback(async () => {
    if (!config) return;
    const parsed = Number.parseInt(maxTeammatesDraft, 10);
    const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TEAMMATES_LIMIT;
    if (!valid || parsed === config.maxTeammates) {
      setMaxTeammatesDraft(String(config.maxTeammates));
      return;
    }
    try {
      const next = await settingService.updateAgentTeamsConfig({ maxTeammates: parsed });
      setConfig(next);
      setMaxTeammatesDraft(String(next.maxTeammates));
    } catch (error) {
      logger.warn("[AgentTeamsSection] 保存人数上限失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setMaxTeammatesDraft(String(config.maxTeammates));
      toast(intl.formatMessage({ id: "settings.agentTeams.updateFailed" }));
    }
  }, [config, intl, maxTeammatesDraft, settingService]);

  if (config === undefined) {
    return null;
  }
  if (config === null) {
    return (
      <div className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.agentTeams.loadFailed" })}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.agentTeams.enable" })}
          description={intl.formatMessage({ id: "settings.agentTeams.enableDescription" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.agentTeams.enable" })}
              checked={config.enabled}
              onCheckedChange={(checked) => {
                void handleEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.agentTeams.maxTeammates" })}
          description={intl.formatMessage({ id: "settings.agentTeams.maxTeammatesDescription" })}
          control={
            <Input
              type="number"
              min={1}
              max={MAX_TEAMMATES_LIMIT}
              value={maxTeammatesDraft}
              disabled={!config.enabled}
              aria-label={intl.formatMessage({ id: "settings.agentTeams.maxTeammates" })}
              onChange={(event) => setMaxTeammatesDraft(event.target.value)}
              onBlur={() => {
                void commitMaxTeammates();
              }}
              className="w-[120px]"
            />
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
