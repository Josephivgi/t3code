import type { EnvironmentId, PluginId, PluginRecord } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useEnvironmentPluginsApi, type PluginsApi } from "../../lib/pluginsApi";

export interface EnvironmentPluginsState {
  readonly api: PluginsApi | null;
  readonly plugins: ReadonlyArray<PluginRecord>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** Live view of the environment's plugin store; refreshes after every mutation the UI makes. */
export function useEnvironmentPlugins(
  environmentId: EnvironmentId | null,
): EnvironmentPluginsState {
  const api = useEnvironmentPluginsApi(environmentId);
  const [remotePlugins, setRemotePlugins] = useState<ReadonlyArray<PluginRecord>>([]);
  const [loadingState, setLoadingState] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => {
    setLoadingState(true);
    setTick((value) => value + 1);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the plugin list from the environment HTTP API and mirrors it in state
  useEffect(() => {
    if (api === null || tick < 0) return;
    let cancelled = false;
    api
      .list()
      .then((result) => {
        if (cancelled) return;
        setRemotePlugins(result.plugins);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingState(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, tick]);

  const plugins = api === null ? [] : remotePlugins;
  const loading = api !== null && loadingState;
  return { api, plugins, loading, error, refresh };
}

export interface PluginHeaderIcon {
  readonly pluginId: PluginId;
  readonly icon: string;
  readonly title: string;
  readonly href?: string | undefined;
}
export interface PluginPanel {
  readonly pluginId: PluginId;
  readonly id: string;
  readonly title: string;
  readonly html: string;
}
export interface PluginThemeCss {
  readonly pluginId: PluginId;
  readonly href: string;
}

export function enabledPluginContributions(plugins: ReadonlyArray<PluginRecord>) {
  const headerIcons: PluginHeaderIcon[] = [];
  const panels: PluginPanel[] = [];
  const themeCss: PluginThemeCss[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const contributes = plugin.manifest.contributes ?? {};
    for (const icon of contributes.headerIcons ?? []) {
      headerIcons.push({ pluginId: plugin.manifest.id, ...icon });
    }
    for (const panel of contributes.panels ?? []) {
      panels.push({ pluginId: plugin.manifest.id, ...panel });
    }
    for (const href of contributes.themeCss ?? []) {
      themeCss.push({ pluginId: plugin.manifest.id, href });
    }
  }
  return { headerIcons, panels, themeCss };
}
