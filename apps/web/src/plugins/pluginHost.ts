import type { PluginFailure, PluginListResult, PluginSummary } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { isSameOriginBrowserPrimary } from "../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { clampPluginCss } from "./pluginCss";
import { pluginsToRetry } from "./pluginRetry.logic";
import { registerSmallTool, type SmallTool } from "./smallTools";

/** What a client plugin receives from `activate(api)`. */
export interface PluginApi {
  readonly id: string;
  readonly name: string;
  log(message: string): void;
  onCleanup(callback: () => void): void;
  /** Runs a method this plugin's server.js registered with handle(). Args and result are JSON. */
  call(method: string, args?: unknown): Promise<unknown>;
  /** Lists a tool under Settings > Small tools. It is removed when the plugin unloads. */
  registerSmallTool(tool: SmallTool): void;
}

interface LoadedPlugin {
  readonly id: string;
  readonly cleanups: Array<() => void>;
  style?: HTMLStyleElement;
}

const BOOT_CONFIRM_MS = 5_000;
const BOOT_CONFIRM_RETRY_MS = 2_000;
/** Retries cover the server's 60 s boot grace period. */
const BOOT_CONFIRM_ATTEMPTS = 30;
/** How often a visible page checks for plugin changes, so a plugin an agent writes shows up live. */
const SYNC_INTERVAL_MS = 4_000;
const CLIENT_BUILD = import.meta.env.T3CODE_BUILD_STAMP;

const loaded = new Map<string, LoadedPlugin>();
/** Blob URL of each loaded plugin module. Errors name it in their stack, which is how they are blamed. */
const moduleUrlToPlugin = new Map<string, string>();
let started = false;
let loadedRevision = -1;
/** Plugins this page is turning off, so a second failure of the same plugin is not recorded twice. */
const turningOff = new Set<string>();
let reloading = false;
/** Plugins this page loaded that the server has not yet been told started fine. */
let unconfirmedBootIds: string[] = [];
/** Plugins this page already turned back on after an update, so it never retries one twice. */
const retriedThisPage = new Set<string>();
/** Failures already shown on this page, so a live refresh does not repeat the toast. */
const announcedFailures = new Set<string>();

/** Fetch failures. The server is at fault, so the plugin is not turned off for these. */
const fetchFailures = new WeakSet<Error>();

const describeError = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message || cause.name;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
};

/** HTTP status of each failed response, so a retry can tell a server that is down from a refusal. */
const responseStatus = new WeakMap<Error, number>();

/**
 * Same auth as the app's other environment requests: cookies when the page is served by the
 * server itself, otherwise the desktop bearer token. The packaged server answers CORS with a
 * wildcard origin, which browsers refuse for cookie requests.
 */
const authorizedInit = async (init: RequestInit | undefined): Promise<RequestInit> => {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  if (isSameOriginBrowserPrimary()) return { ...init, headers, credentials: "include" };
  const token = await readDesktopPrimaryBearerToken().catch(() => null);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers, credentials: "omit" };
};

const requestJson = async <T>(
  path: string,
  init?: RequestInit,
  searchParams?: Record<string, string>,
): Promise<T> => {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl(path, searchParams),
    await authorizedInit(init),
  );
  if (!response.ok) {
    const failure = new Error(`${init?.method ?? "GET"} ${path} failed with ${response.status}.`);
    responseStatus.set(failure, response.status);
    throw failure;
  }
  return (await response.json()) as T;
};

const fetchList = () => requestJson<PluginListResult>("/api/plugins");

const LIST_ATTEMPTS = 5;
const LIST_RETRY_MS = 2_000;

/** Retries the first list, so a short outage at page load does not leave the page without plugins. */
async function fetchPluginListWithRetry(): Promise<PluginListResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchList();
    } catch (cause) {
      // A network failure or a 5xx (the server is restarting) is worth retrying; a refusal is final.
      const status = cause instanceof Error ? responseStatus.get(cause) : undefined;
      const retryable = status === undefined || status >= 500;
      if (!retryable || attempt >= LIST_ATTEMPTS) throw cause;
      await new Promise((resolve) => window.setTimeout(resolve, LIST_RETRY_MS));
    }
  }
}

/** The last plugin list this page fetched, for the Settings page. */
let latestList: PluginListResult | null = null;
const listListeners = new Set<() => void>();

const publishList = (list: PluginListResult) => {
  // The timer refetches often; an unchanged list must not re-render the Settings page.
  if (latestList !== null && JSON.stringify(latestList) === JSON.stringify(list)) return;
  latestList = list;
  for (const listener of listListeners) listener();
};

export const getPluginList = (): PluginListResult | null => latestList;

/** For useSyncExternalStore: tells a component when the plugin list changes. */
export const subscribePluginList = (listener: () => void) => {
  listListeners.add(listener);
  return () => {
    listListeners.delete(listener);
  };
};

/** Fetches the plugin list for the Settings page, retrying a short outage. */
export async function refreshPluginList(): Promise<PluginListResult> {
  const list = await fetchPluginListWithRetry();
  publishList(list);
  return list;
}

/** Turns a plugin on or off. Turning it on clears its recorded failure. */
export const setPluginEnabled = (id: string, enabled: boolean) => postState(id, { enabled });

/** Deletes a plugin and its files. */
export const deletePlugin = (id: string) =>
  requestJson<{ deleted: true }>(`/api/plugins/${encodeURIComponent(id)}/delete`, {
    method: "POST",
    body: "{}",
  });

const fetchFile = async (id: string, file: "client.js" | "style.css") => {
  try {
    const result = await requestJson<{ content: string }>(
      `/api/plugins/${encodeURIComponent(id)}/file`,
      undefined,
      { path: file },
    );
    return result.content;
  } catch (cause) {
    const failure = new Error(`${file} could not be read: ${describeError(cause)}`);
    fetchFailures.add(failure);
    throw failure;
  }
};

const postState = (id: string, body: unknown) =>
  requestJson<PluginSummary>(`/api/plugins/${encodeURIComponent(id)}/state`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/**
 * Turns a plugin off on the server, then reloads so the page starts without it. The reason is
 * saved with the plugin and shown after the reload. If the server cannot be reached, nothing
 * reloads: a reload would load the broken plugin again.
 */
async function turnOff(id: string, phase: PluginFailure["phase"], message: string, stack?: string) {
  if (reloading || turningOff.has(id)) return;
  turningOff.add(id);
  const failure: PluginFailure = {
    at: new Date().toISOString(),
    phase,
    message,
    ...(stack === undefined ? {} : { stack }),
    build: CLIENT_BUILD,
  };
  try {
    await postState(id, { enabled: false, failure });
  } catch (cause) {
    turningOff.delete(id);
    toastManager.add({
      type: "error",
      title: `Could not turn off the plugin "${id}"`,
      description: `${message} The change could not be saved on the server, so the page was not reloaded.`,
    });
    console.error(`[plugin ${id}] could not be turned off`, cause);
    return;
  }
  // One reload picks up every plugin turned off on this page.
  reloading = true;
  window.location.reload();
}

/**
 * Tells the server this page runs its plugins fine. Sent on the timer, or when the page is
 * closed normally: a page that crashes or hangs never sends it, which is how the server finds it.
 */
function confirmBoot(keepalive: boolean, attempt = 0) {
  const ids = unconfirmedBootIds;
  if (ids.length === 0) return;
  requestJson("/api/plugins/boot/ok", {
    method: "POST",
    body: JSON.stringify({ ids }),
    keepalive,
  })
    .then(() => {
      unconfirmedBootIds = unconfirmedBootIds.filter((id) => !ids.includes(id));
    })
    .catch(() => {
      // A brief server outage must not look like a crash, so keep trying for the grace period.
      if (keepalive || attempt >= BOOT_CONFIRM_ATTEMPTS) return;
      window.setTimeout(() => confirmBoot(false, attempt + 1), BOOT_CONFIRM_RETRY_MS);
    });
}

function blame(source: string): string | undefined {
  for (const [url, id] of moduleUrlToPlugin) {
    if (source.includes(url)) return id;
  }
  return undefined;
}

function onWindowError(event: ErrorEvent) {
  const id = blame(`${event.filename ?? ""}\n${event.error?.stack ?? ""}`);
  if (id === undefined) return;
  const stack = event.error instanceof Error ? event.error.stack : undefined;
  void turnOff(
    id,
    "client-runtime",
    `The plugin threw while running: ${describeError(event.error ?? event.message)}`,
    stack,
  );
}

function onUnhandledRejection(event: PromiseRejectionEvent) {
  const reason = event.reason;
  const id = blame(reason instanceof Error ? (reason.stack ?? "") : "");
  if (id === undefined) return;
  const stack = reason instanceof Error ? reason.stack : undefined;
  void turnOff(
    id,
    "client-runtime",
    `The plugin left a promise rejected: ${describeError(reason)}`,
    stack,
  );
}

function unloadAll() {
  for (const plugin of loaded.values()) {
    for (const cleanup of plugin.cleanups) {
      try {
        cleanup();
      } catch (cause) {
        // A plugin's cleanup must not stop the others from unloading.
        console.warn(`[plugin ${plugin.id}] cleanup threw`, cause);
      }
    }
    plugin.style?.remove();
  }
  loaded.clear();
}

async function loadPlugin(summary: PluginSummary): Promise<void> {
  const id = summary.id;
  const plugin: LoadedPlugin = { id, cleanups: [] };
  loaded.set(id, plugin);
  try {
    if (summary.hasStyle) {
      const css = await fetchFile(id, "style.css");
      const style = document.createElement("style");
      style.dataset.pluginId = id;
      style.textContent = clampPluginCss(css);
      document.head.append(style);
      plugin.style = style;
    }
    if (summary.hasClient) {
      const code = await fetchFile(id, "client.js");
      const moduleUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      moduleUrlToPlugin.set(moduleUrl, id);
      const module: { default?: unknown } = await import(/* @vite-ignore */ moduleUrl).finally(() =>
        URL.revokeObjectURL(moduleUrl),
      );
      if (typeof module.default !== "function") {
        throw new Error("client.js must export a default activate(api) function.");
      }
      const api: PluginApi = {
        id,
        name: summary.name,
        log: (message) => console.info(`[plugin ${id}] ${message}`),
        onCleanup: (callback) => {
          plugin.cleanups.push(callback);
        },
        call: async (method, args) => {
          const answer = await requestJson<{ ok: boolean; result?: unknown; error?: string }>(
            `/api/plugins/${encodeURIComponent(id)}/call`,
            { method: "POST", body: JSON.stringify({ method, args }) },
          );
          if (!answer.ok) throw new Error(answer.error ?? `${method} failed.`);
          return answer.result;
        },
        registerSmallTool: (tool) => {
          plugin.cleanups.push(registerSmallTool(id, tool));
        },
      };
      await (module.default as (api: PluginApi) => unknown)(api);
    }
  } catch (cause) {
    if (cause instanceof Error && fetchFailures.has(cause)) {
      // Not the plugin's fault. It stays on and loads on the next change or page load.
      console.warn(`[plugin ${id}] not started: ${cause.message}`);
      toastManager.add({
        type: "warning",
        title: `${summary.name} did not start`,
        description: "Its files could not be loaded. Reload the page to try again.",
      });
      return;
    }
    const stack = cause instanceof Error ? cause.stack : undefined;
    await turnOff(
      id,
      "client-activate",
      `The plugin failed while starting: ${describeError(cause)}`,
      stack,
    );
    throw cause;
  }
}

function announceFailures(list: PluginListResult) {
  for (const plugin of list.plugins) {
    if (plugin.failure === undefined || plugin.failureAcknowledged) continue;
    const key = `${plugin.id}@${plugin.failure.at}`;
    if (announcedFailures.has(key)) continue;
    announcedFailures.add(key);
    const id = plugin.id;
    const toastId = toastManager.add({
      type: "error",
      title: `${plugin.name} was turned off`,
      description: plugin.failure.message,
      actionProps: {
        children: "Got it",
        onClick: () => {
          void postState(id, { acknowledge: true }).then(
            () => toastManager.close(toastId),
            () =>
              toastManager.add({
                type: "error",
                title: `${plugin.name} notice could not be saved`,
                description: "Click Got it to try again.",
                timeout: 0,
              }),
          );
        },
      },
    });
  }
}

/** Unloads every plugin and loads the enabled ones from `list`, so changes apply without a reload. */
async function applyList(fetched: PluginListResult) {
  let list = fetched;
  const retry = pluginsToRetry(list, CLIENT_BUILD, retriedThisPage);
  if (retry.length > 0) {
    for (const id of retry) retriedThisPage.add(id);
    const results = await Promise.allSettled(retry.map((id) => setPluginEnabled(id, true)));
    if (results.some((result) => result.status === "fulfilled")) {
      list = await fetchList().catch(() => list);
    }
  }
  publishList(list);
  announceFailures(list);
  unloadAll();
  loadedRevision = list.revision;

  const toLoad = list.plugins.filter(
    (plugin) => plugin.enabled && (plugin.hasClient || plugin.hasStyle),
  );
  if (toLoad.length === 0) return;

  const ids = toLoad.map((plugin) => plugin.id);
  unconfirmedBootIds = [...new Set([...unconfirmedBootIds, ...ids])];
  try {
    await requestJson("/api/plugins/boot/start", {
      method: "POST",
      body: JSON.stringify({ ids, build: CLIENT_BUILD }),
    });
  } catch (cause) {
    console.warn("Plugin start could not be recorded.", cause);
  }

  for (const summary of toLoad) {
    if (reloading) return;
    await loadPlugin(summary).catch(() => undefined);
  }

  // The plugins count as started once the page has run this long without a plugin error. Until
  // then, a page that crashes or hangs leaves them marked as unconfirmed.
  window.setTimeout(() => confirmBoot(false), BOOT_CONFIRM_MS);
}

let syncInFlight: Promise<void> | null = null;

/**
 * Applies plugin changes made since this page loaded them. Called on a timer, when the page
 * becomes visible, and after a change in Settings.
 */
export function syncPlugins(): Promise<void> {
  if (!started || reloading) return Promise.resolve();
  syncInFlight ??= fetchList()
    .then((list) => {
      if (list.revision === loadedRevision) {
        publishList(list);
        return;
      }
      return applyList(list);
    })
    .finally(() => {
      syncInFlight = null;
    });
  return syncInFlight;
}

function watchForChanges() {
  const syncQuietly = () => {
    if (document.visibilityState !== "visible") return;
    syncPlugins().catch(() => undefined);
  };
  document.addEventListener("visibilitychange", syncQuietly);
  window.addEventListener("focus", syncQuietly);
  window.setInterval(syncQuietly, SYNC_INTERVAL_MS);
}

/** Starts client plugins once per page. Safe to call again; later calls do nothing. */
export async function startPluginHost(): Promise<void> {
  if (started) return;
  started = true;
  window.addEventListener("pagehide", () => {
    unloadAll();
    confirmBoot(true);
  });
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  // A page started in a background tab confirms as soon as someone looks at it.
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") confirmBoot(false);
    },
    { once: true },
  );

  let list: PluginListResult;
  try {
    list = await fetchPluginListWithRetry();
  } catch (cause) {
    console.warn("Plugins could not be listed.", cause);
    toastManager.add({
      type: "error",
      title: "Plugins did not load",
      description: "Reload Azon Beta to load them.",
    });
    // Keep watching, so the plugins load once the server answers.
    watchForChanges();
    return;
  }
  await applyList(list);
  watchForChanges();
}
