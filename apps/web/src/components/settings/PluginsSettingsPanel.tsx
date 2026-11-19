import type { PluginRecord } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { PuzzleIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentPlugins } from "../plugins/useEnvironmentPlugins";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function PluginRow({
  plugin,
  busy,
  onSetEnabled,
  onRemove,
}: {
  readonly plugin: PluginRecord;
  readonly busy: boolean;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <PuzzleIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{plugin.manifest.name}</span>
          <span className="text-xs text-muted-foreground">v{plugin.manifest.version}</span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {plugin.manifest.id} · {plugin.manifest.capabilities.join(", ")}
        </div>
        {plugin.manifest.description ? (
          <div className="truncate text-xs text-muted-foreground">
            {plugin.manifest.description}
          </div>
        ) : null}
      </div>
      <Switch
        checked={plugin.enabled}
        disabled={busy}
        onCheckedChange={(checked) => onSetEnabled(checked)}
        aria-label={gt("Enable {name}", { name: plugin.manifest.name })}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        onClick={onRemove}
        aria-label={gt("Remove {name}", { name: plugin.manifest.name })}
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
}

export function PluginsSettingsPanel() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { api, plugins, loading, error, refresh } = useEnvironmentPlugins(environmentId);
  const [sourcePath, setSourcePath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<unknown>, done: string) => {
    if (api === null) return;
    setBusy(key);
    try {
      await action();
      refresh();
      toastManager.add({ title: done });
    } catch (cause) {
      toastManager.add({
        title: gt("Plugin operation failed"),
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title={gt("Plugins")}>
        <p className="text-sm text-muted-foreground">
          {gt(
            "Install, enable, disable and remove plugins on this environment. Every change is journaled and can be reverted.",
          )}
        </p>
        {api === null ? (
          <p className="text-sm text-muted-foreground">
            {gt("Connect to an environment to manage its plugins.")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input
                value={sourcePath}
                onChange={(event) => setSourcePath(event.target.value)}
                placeholder={gt("Absolute path to a plugin directory on the server")}
                className="flex-1"
              />
              <Button
                disabled={busy !== null || sourcePath.trim().length === 0}
                onClick={() =>
                  void run("install", () => api.install(sourcePath.trim()), gt("Plugin installed"))
                }
              >
                {gt("Install")}
              </Button>
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void run("revert", () => api.revert(), gt("Last plugin change reverted"))
                }
              >
                <RotateCcwIcon className="size-4" />
                {gt("Revert last change")}
              </Button>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {loading ? (
              <p className="text-sm text-muted-foreground">{gt("Loading plugins…")}</p>
            ) : plugins.length === 0 ? (
              <p className="text-sm text-muted-foreground">{gt("No plugins installed.")}</p>
            ) : (
              plugins.map((plugin) => (
                <PluginRow
                  key={plugin.manifest.id}
                  plugin={plugin}
                  busy={busy !== null}
                  onSetEnabled={(enabled) =>
                    void run(
                      `${plugin.manifest.id}:set`,
                      () => api.setEnabled(plugin.manifest.id, enabled),
                      enabled ? gt("Plugin enabled") : gt("Plugin disabled"),
                    )
                  }
                  onRemove={() =>
                    void run(
                      `${plugin.manifest.id}:remove`,
                      () => api.remove(plugin.manifest.id),
                      gt("Plugin removed (revertable)"),
                    )
                  }
                />
              ))
            )}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
