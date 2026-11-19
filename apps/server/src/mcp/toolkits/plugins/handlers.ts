import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PluginManager from "../../../plugins/PluginManager.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PluginsToolkit } from "./tools.ts";

const fail = (cause: PluginManager.PluginError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message });

export const layer = McpToolAccess.toLayer(PluginsToolkit, {
  t3_plugins_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const plugins = yield* PluginManager.PluginManagerService;
      return yield* plugins.list;
    }),
  ),
  t3_plugins_install: McpToolAccess.writes(({ sourcePath, enable }) =>
    Effect.gen(function* () {
      const plugins = yield* PluginManager.PluginManagerService;
      const plugin = yield* plugins
        .install({ sourcePath, ...(enable === undefined ? {} : { enable }) })
        .pipe(Effect.catch(fail));
      return { ok: true as const, plugin };
    }),
  ),
  t3_plugins_set_enabled: McpToolAccess.writes(({ pluginId, enabled }) =>
    Effect.gen(function* () {
      const plugins = yield* PluginManager.PluginManagerService;
      const plugin = yield* plugins.setEnabled(pluginId, enabled).pipe(Effect.catch(fail));
      return { ok: true as const, plugin };
    }),
  ),
  t3_plugins_remove: McpToolAccess.writes(({ pluginId }) =>
    Effect.gen(function* () {
      const plugins = yield* PluginManager.PluginManagerService;
      yield* plugins.remove(pluginId).pipe(Effect.catch(fail));
      return { ok: true as const };
    }),
  ),
  t3_plugins_revert: McpToolAccess.writes(({ pluginId }) =>
    Effect.gen(function* () {
      const plugins = yield* PluginManager.PluginManagerService;
      const result = yield* plugins.revert(pluginId).pipe(Effect.catch(fail));
      return {
        ok: true as const,
        reverted: result.reverted,
        ...(result.plugin === undefined ? {} : { plugin: result.plugin }),
      };
    }),
  ),
});
