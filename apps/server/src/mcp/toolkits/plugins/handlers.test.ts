import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, PluginId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as PluginStore from "../../../plugins/PluginStore.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as PluginHandlers from "./handlers.ts";
import { PluginsToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:plugins");
const threadId = ThreadId.make("thread:plugins");

const manifest = JSON.stringify({ id: "tool-check", name: "Tool check", version: "1.0.0" });

it.layer(NodeServices.layer)("plugin MCP tools", (it) => {
  it.effect("writes, reads, toggles and deletes a plugin through the tools", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "azon-plugin-tools-" });
      const layerDependencies = Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:plugins",
          thread: {
            threadId,
            providerSessionId: "provider:plugins",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        PluginStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      );

      yield* Effect.gen(function* () {
        const toolkit = yield* PluginsToolkit;
        const run = <
          Name extends
            | "t3_plugin_list"
            | "t3_plugin_read"
            | "t3_plugin_write"
            | "t3_plugin_set_enabled"
            | "t3_plugin_delete",
        >(
          name: Name,
          params: Parameters<typeof toolkit.handle<Name>>[1],
        ) =>
          toolkit.handle(name, params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );
        const id = PluginId.make("tool-check");

        expect(
          yield* run("t3_plugin_write", {
            id,
            files: [
              { path: "plugin.json", content: manifest },
              { path: "client.js", content: "export default function activate() {}" },
              { path: "style.css", content: ":root { --accent: red; }" },
            ],
          }),
        ).toMatchObject({
          plugin: { id, enabled: true, hasClient: true, hasStyle: true, hasServer: false },
          restartRequired: false,
        });

        expect(yield* run("t3_plugin_list", {})).toMatchObject({
          plugins: [{ id, enabled: true }],
        });
        expect(yield* run("t3_plugin_list", { id: PluginId.make("missing-one") })).toMatchObject({
          plugins: [],
        });

        expect(yield* run("t3_plugin_read", { id, path: "client.js" })).toMatchObject({
          plugin: { id },
          files: expect.arrayContaining(["plugin.json", "client.js", "style.css"]),
          file: { id, path: "client.js", content: "export default function activate() {}" },
          guide: expect.stringContaining("plugin"),
        });

        expect(yield* run("t3_plugin_set_enabled", { id, enabled: false })).toMatchObject({
          id,
          enabled: false,
        });

        expect(
          yield* run("t3_plugin_write", {
            id,
            files: [{ path: "server.js", content: "export function activate() {}" }],
          }),
        ).toMatchObject({ restartRequired: true });

        expect(yield* run("t3_plugin_delete", { id })).toEqual({ deleted: true });
        expect(yield* run("t3_plugin_list", {})).toMatchObject({ plugins: [] });
        expect(yield* run("t3_plugin_read", { id })).toMatchObject({
          code: "invalid_request",
          message: 'No plugin named "tool-check".',
        });
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(PluginHandlers.layer).pipe(
            Layer.provideMerge(layerDependencies),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );
});
