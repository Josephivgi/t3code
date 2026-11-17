import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PluginStore from "../../../plugins/PluginStore.ts";
import { PLUGIN_GUIDE } from "../../../plugins/pluginGuide.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PluginsToolkit } from "./tools.ts";

const toMcpFailure = (error: PluginStore.PluginStoreError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "io" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(PluginsToolkit, {
  t3_plugin_list: McpToolAccess.reads(({ id }) =>
    Effect.gen(function* () {
      const store = yield* PluginStore.PluginStore;
      const listing = yield* store.list.pipe(Effect.mapError(toMcpFailure));
      if (id === undefined) return listing;
      return {
        revision: listing.revision,
        plugins: listing.plugins.filter((plugin) => plugin.id === id),
      };
    }),
  ),
  t3_plugin_read: McpToolAccess.reads(({ id, path }) =>
    Effect.gen(function* () {
      const store = yield* PluginStore.PluginStore;
      const listing = yield* store.list.pipe(Effect.mapError(toMcpFailure));
      const plugin = listing.plugins.find((entry) => entry.id === id);
      if (plugin === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `No plugin named "${id}".`,
        });
      }
      const files = yield* store.files(id).pipe(Effect.mapError(toMcpFailure));
      const file =
        path === undefined
          ? undefined
          : yield* store.readFile(id, path).pipe(Effect.mapError(toMcpFailure));
      return {
        plugin,
        files,
        ...(file === undefined ? {} : { file }),
        guide: PLUGIN_GUIDE,
      };
    }),
  ),
  t3_plugin_write: McpToolAccess.writesEnvironment(
    ({ id, files }, check) =>
      Effect.gen(function* () {
        yield* check;
        const store = yield* PluginStore.PluginStore;
        return yield* store.write(id, files).pipe(Effect.mapError(toMcpFailure));
      }),
    { fullAccess: "not-required" },
  ),
  t3_plugin_set_enabled: McpToolAccess.writesEnvironment(
    ({ id, enabled }, check) =>
      Effect.gen(function* () {
        yield* check;
        const store = yield* PluginStore.PluginStore;
        return yield* store.setState(id, { enabled }).pipe(Effect.mapError(toMcpFailure));
      }),
    { fullAccess: "not-required" },
  ),
  t3_plugin_delete: McpToolAccess.writesEnvironment(
    ({ id }, check) =>
      Effect.gen(function* () {
        yield* check;
        const store = yield* PluginStore.PluginStore;
        yield* store.remove(id).pipe(Effect.mapError(toMcpFailure));
        return { deleted: true as const };
      }),
    { fullAccess: "not-required" },
  ),
});
