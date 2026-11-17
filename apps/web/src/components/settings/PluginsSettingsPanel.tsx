import type { PluginFailure, PluginPhase, PluginSummary } from "@t3tools/contracts";
import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useUiStyle } from "../../hooks/useSettings";

import {
  deletePlugin,
  getPluginList,
  refreshPluginList,
  setPluginEnabled,
  subscribePluginList,
  syncPlugins,
} from "../../plugins/pluginHost";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const PHASE_WORDS: Readonly<Record<PluginPhase, string>> = {
  "client-activate": "while it was starting in the page",
  "client-runtime": "while it was running in the page",
  "client-boot": "when the page started",
  "server-activate": "while the server was loading it",
  "server-boot": "when the server started",
  manifest: "when Azon Beta read it",
};

/** A network failure throws a TypeError; a server answer that is not ok throws an Error. */
const failureReason = (cause: unknown): string =>
  cause instanceof TypeError
    ? "The server could not be reached."
    : "The server refused the change.";

const formatTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

function FailureNotice({
  failure,
  onTurnOn,
  busy,
}: {
  failure: PluginFailure;
  onTurnOn: () => void;
  busy: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const unreadable = failure.phase === "manifest";
  return (
    <div className="mt-2 rounded-md border border-destructive/24 bg-destructive/6 p-3 text-sm">
      <p className="font-medium text-destructive-foreground">
        {unreadable ? failure.message : `Turned off automatically: ${failure.message}`}
      </p>
      {unreadable ? null : (
        <p className="mt-1 text-muted-foreground">
          It failed {PHASE_WORDS[failure.phase]}, at {formatTime(failure.at)}. Fix the plugin, then
          turn it on again.
          {failure.phase.startsWith("client-")
            ? " Azon Beta also tries it once more after an update."
            : ""}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        {unreadable ? null : (
          <Button size="sm" variant="outline" disabled={busy} onClick={onTurnOn}>
            Turn on again
          </Button>
        )}
        {failure.stack !== undefined ? (
          <Button size="sm" variant="ghost" onClick={() => setShowDetails((open) => !open)}>
            {showDetails ? "Hide details" : "Show details"}
          </Button>
        ) : null}
      </div>
      {showDetails && failure.stack !== undefined ? (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">
          {failure.stack}
        </pre>
      ) : null}
    </div>
  );
}

function PluginCard({
  plugin,
  busy,
  onToggle,
  onDelete,
}: {
  plugin: PluginSummary;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const azonLayout = useUiStyle() === "azon";
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const unreadable = plugin.failure?.phase === "manifest";
  const parts = [
    plugin.hasClient ? "Page code" : null,
    plugin.hasStyle ? "Styles" : null,
    plugin.hasServer ? "Server code" : null,
  ].filter((part): part is string => part !== null);
  const failed = plugin.failure !== undefined && !plugin.enabled;

  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{plugin.name}</span>
            {plugin.failure?.phase === "manifest" ? null : (
              <span className="text-xs text-muted-foreground">v{plugin.version}</span>
            )}
            <Badge variant="outline" size="sm">
              {plugin.supports.includes("t3code") ? "T3 Code + Azon" : "Azon only"}
            </Badge>
            {plugin.enabled ? (
              <Badge variant="success" size="sm">
                On
              </Badge>
            ) : failed ? (
              <Badge variant="error" size="sm">
                Off, failed
              </Badge>
            ) : (
              <Badge variant="secondary" size="sm">
                Off
              </Badge>
            )}
          </div>
          {plugin.description !== undefined ? (
            <p className="mt-1 text-sm text-muted-foreground">{plugin.description}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            ID <code className="font-mono">{plugin.id}</code>
            {parts.length > 0 ? ` · Includes ${parts.join(", ").toLowerCase()}` : " · No code"}{" "}
          </p>
        </div>
        <Switch
          checked={plugin.enabled}
          disabled={busy || unreadable}
          onCheckedChange={(checked) => onToggle(Boolean(checked))}
          aria-label={`Turn ${plugin.name} on or off`}
        />
      </div>
      {plugin.failure !== undefined && !plugin.enabled ? (
        <FailureNotice failure={plugin.failure} busy={busy} onTurnOn={() => onToggle(true)} />
      ) : null}
      <div className="mt-1 flex items-center gap-2">
        {confirmingDelete ? (
          <>
            <span className="text-xs text-muted-foreground">Delete its files for good?</span>
            <Button size="sm" variant="destructive" disabled={busy} onClick={onDelete}>
              Delete plugin
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant={azonLayout ? "ghost-destructive" : "ghost"}
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          >
            {azonLayout ? <Trash2Icon className="size-3.5" /> : null}
            Delete…
          </Button>
        )}
      </div>
    </div>
  );
}

export function PluginsSettingsPanel() {
  const azonLayout = useUiStyle() === "azon";
  // The plugin host refreshes this list when plugins change, including ones an agent writes.
  const list = useSyncExternalStore(subscribePluginList, getPluginList);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    setLoading(true);
    return refreshPluginList()
      .then(() => setError(null))
      .catch(() => setError("The plugins could not be loaded from this server."))
      .finally(() => setLoading(false));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the server's plugin list when this page opens
  useEffect(() => {
    let active = true;
    refreshPluginList()
      .then(() => {
        if (active) setError(null);
      })
      .catch(() => {
        if (active) setError("The plugins could not be loaded from this server.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // The change is already saved here, so a failed apply says so instead of reporting a refusal.
  const applyAfterChange = (done: string) =>
    syncPlugins()
      .then(() => refreshPluginList())
      .then(() => setError(null))
      .catch(() => setError(`${done}, but this window did not apply it. Reload Azon Beta.`));

  const toggle = (plugin: PluginSummary, enabled: boolean) => {
    setBusyId(plugin.id);
    setPluginEnabled(plugin.id, enabled)
      .then(
        () => applyAfterChange(`${plugin.name} was ${enabled ? "turned on" : "turned off"}`),
        (cause: unknown) =>
          setError(
            `${plugin.name} could not be ${enabled ? "turned on" : "turned off"}. ${failureReason(cause)}`,
          ),
      )
      .finally(() => setBusyId(null));
  };

  const remove = (plugin: PluginSummary) => {
    setBusyId(plugin.id);
    deletePlugin(plugin.id)
      .then(
        () => applyAfterChange(`${plugin.name} was deleted`),
        (cause: unknown) =>
          setError(`${plugin.name} could not be deleted. ${failureReason(cause)}`),
      )
      .finally(() => setBusyId(null));
  };

  const plugins = list?.plugins ?? [];

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="plugins"
        title="Plugins"
        {...(azonLayout
          ? {
              headerAction: (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading}
                  onClick={() => void reload()}
                >
                  <RefreshCwIcon className="size-3.5" />
                  {loading ? "Refreshing…" : "Refresh"}
                </Button>
              ),
            }
          : {
              titleAction: (
                <Button size="sm" variant="ghost" disabled={loading} onClick={() => void reload()}>
                  {loading ? "Refreshing…" : "Refresh"}
                </Button>
              ),
            })}
      >
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Plugins change how Azon Beta looks and works. Plugin code runs inside the app with the
          app's full access, so only turn on plugins you trust. A plugin that breaks the app is
          turned off automatically, and the reason stays here. Changes apply right away.
        </p>
        {error !== null ? <p className="px-4 py-3 text-sm text-destructive">{error}</p> : null}
        {list === null && error === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading plugins…</p>
        ) : null}
        {list !== null && plugins.length === 0 ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            <p>No plugins are installed.</p>
            <p className="mt-1">Ask an agent to add one. It starts turned on.</p>
          </div>
        ) : null}
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            busy={busyId === plugin.id}
            onToggle={(enabled) => toggle(plugin, enabled)}
            onDelete={() => remove(plugin)}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
