import {
  PluginListResult,
  PluginOperationResult,
  type PluginId,
  type PluginRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { EnvironmentId } from "@t3tools/contracts";
import { usePreparedConnection } from "../state/session";

const decodeList = Schema.decodeUnknownSync(PluginListResult);
const decodeOperation = Schema.decodeUnknownSync(PluginOperationResult);

const pluginsChangedTarget = new EventTarget();
const PLUGINS_CHANGED_EVENT = "plugins-changed";

/** Refreshes every mounted `useEnvironmentPlugins` after a mutation made through this API. */
function notifyPluginsChanged() {
  pluginsChangedTarget.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT));
}

export function subscribePluginsChanged(listener: () => void): () => void {
  pluginsChangedTarget.addEventListener(PLUGINS_CHANGED_EVENT, listener);
  return () => pluginsChangedTarget.removeEventListener(PLUGINS_CHANGED_EVENT, listener);
}

async function requestJson(input: {
  readonly baseUrl: string;
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
}) {
  const init: RequestInit =
    input.body === undefined
      ? { method: input.method, credentials: "include" }
      : {
          method: input.method,
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input.body),
        };
  const response = await fetch(`${input.baseUrl}${input.path}`, init);
  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const error = (await response.json()) as {
        message?: string;
        reason?: string;
        detail?: string;
      };
      detail = error.detail ?? error.message ?? error.reason ?? detail;
    } catch {
      // keep status detail
    }
    throw new Error(`Plugin request failed: ${detail}`);
  }
  return response.json() as Promise<unknown>;
}

export interface PluginsApi {
  readonly baseUrl: string;
  list(): Promise<Schema.Schema.Type<typeof PluginListResult>>;
  install(sourcePath: string): Promise<PluginRecord>;
  setEnabled(pluginId: PluginId, enabled: boolean): Promise<void>;
  remove(pluginId: PluginId): Promise<void>;
  revert(pluginId?: PluginId): Promise<string>;
}

function makePluginsApi(rawBaseUrl: string): PluginsApi {
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const post = (path: string, body?: unknown) =>
    requestJson({ baseUrl, path, method: "POST", body });
  return {
    baseUrl,
    async list() {
      return decodeList(await requestJson({ baseUrl, path: "/api/plugins", method: "GET" }));
    },
    async install(sourcePath) {
      const result = decodeOperation(await post("/api/plugins/install", { sourcePath }));
      if (!("plugin" in result) || result.plugin === undefined) {
        throw new Error("Install did not return a plugin record.");
      }
      notifyPluginsChanged();
      return result.plugin;
    },
    async setEnabled(pluginId, enabled) {
      await post(`/api/plugins/${pluginId}/${enabled ? "enable" : "disable"}`);
      notifyPluginsChanged();
    },
    async remove(pluginId) {
      await post(`/api/plugins/${pluginId}/remove`);
      notifyPluginsChanged();
    },
    async revert(pluginId) {
      const result = decodeOperation(
        await post("/api/plugins/revert", pluginId === undefined ? {} : { pluginId }),
      );
      notifyPluginsChanged();
      return "reverted" in result ? (result.reverted ?? "reverted") : "reverted";
    },
  };
}

export function pluginAssetUrl(api: PluginsApi, pluginId: PluginId, assetPath: string): string {
  return `${api.baseUrl}/api/plugin-assets/${encodeURIComponent(pluginId)}/${assetPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/** Plugins API bound to the environment the UI is connected to, when it is HTTP-reachable. */
export function useEnvironmentPluginsApi(environmentId: EnvironmentId | null): PluginsApi | null {
  const prepared = usePreparedConnection(environmentId);
  if (prepared._tag !== "Some") return null;
  return makePluginsApi(prepared.value.httpBaseUrl);
}
