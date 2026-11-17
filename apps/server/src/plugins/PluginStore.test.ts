import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { PluginId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as PluginStore from "./PluginStore.ts";

const manifest = (id: string) => JSON.stringify({ id, name: `Plugin ${id}`, version: "1.0.0" });

/** Runs `body` against a fresh plugins folder under a temp base dir. */
const withPluginStore = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | PluginStore.PluginStore
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "azon-plugins-" });
    return yield* body.pipe(
      Effect.provide(
        PluginStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  });

const pluginsDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return path.join(config.stateDir, "plugins");
});

it.layer(NodeServices.layer)("PluginStore", (it) => {
  it.effect("writes a plugin, lists it on, and reports its files", () =>
    withPluginStore(
      Effect.gen(function* () {
        const store = yield* PluginStore.PluginStore;
        const result = yield* store.write("theme-tweak" as PluginId, [
          { path: "plugin.json", content: manifest("theme-tweak") },
          { path: "style.css", content: ":root { --accent: red; }" },
          { path: "client.js", content: "export default function activate() {}" },
        ]);
        assert.isFalse(result.restartRequired);
        // Writing the same client.js again changes nothing, so open pages are not told to reload.
        const before = (yield* store.list).revision;
        yield* store.write("theme-tweak" as PluginId, [
          { path: "client.js", content: "export default function activate() {}" },
        ]);
        assert.strictEqual((yield* store.list).revision, before);
        const listing = yield* store.list;
        assert.deepStrictEqual(
          listing.plugins.map((plugin) => [
            plugin.id,
            plugin.enabled,
            plugin.hasClient,
            plugin.hasStyle,
            plugin.hasServer,
          ]),
          [["theme-tweak", true, true, true, false]],
        );
        // Only a changed server.js asks for a restart.
        const serverFile = [{ path: "server.js" as const, content: "export default {};" }];
        assert.isTrue((yield* store.write("theme-tweak" as PluginId, serverFile)).restartRequired);
        assert.isFalse((yield* store.write("theme-tweak" as PluginId, serverFile)).restartRequired);
      }),
    ),
  );

  it.effect("refuses a file that is not a plugin file", () =>
    withPluginStore(
      Effect.gen(function* () {
        const store = yield* PluginStore.PluginStore;
        const error = yield* store
          .write("sneaky" as PluginId, [
            { path: "plugin.json", content: manifest("sneaky") },
            { path: "../escape.js", content: "x" },
          ])
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid");
      }),
    ),
  );

  it.effect("keeps nested files such as Rust source and lists them without build output", () =>
    withPluginStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* PluginStore.PluginStore;
        const id = "has-rust" as PluginId;
        yield* store.write(id, [
          { path: "plugin.json", content: manifest(id) },
          { path: "native/src/lib.rs", content: "fn main() {}" },
        ]);
        const dir = yield* pluginsDir;
        yield* fs.makeDirectory(path.join(dir, id, "native", "target"), { recursive: true });
        yield* fs.writeFileString(path.join(dir, id, "native", "target", "big.rlib"), "x");
        assert.deepStrictEqual([...(yield* store.files(id))].toSorted(), [
          "native/src/lib.rs",
          "plugin.json",
        ]);
        const read = yield* store.readFile(id, "native/src/lib.rs");
        assert.strictEqual(read.content, "fn main() {}");
      }),
    ),
  );

  it.effect("runs a method server.js registered and reports a throwing one without failing", () =>
    withPluginStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* PluginStore.PluginStore;
        const id = "calls-back" as PluginId;
        yield* store.write(id, [
          { path: "plugin.json", content: manifest(id) },
          {
            path: "server.js",
            content: `import { writeFileSync } from "node:fs";
            export default function activate({ handle, dataDir }) {
              handle("double", (n) => n * 2);
              handle("boom", () => { throw new Error("nope"); });
              handle("where", () => dataDir);
              return () => writeFileSync(dataDir + "/cleaned", "yes");
            }`,
          },
        ]);
        yield* store.activateServerPlugins;
        const doubled = yield* store.call(id, "double", 21);
        assert.deepStrictEqual(doubled, { ok: true, result: 42 });
        const boom = yield* store.call(id, "boom", null);
        assert.deepStrictEqual(boom, { ok: false, error: "nope" });
        const where = yield* store.call(id, "where", null);
        const config = yield* ServerConfig.ServerConfig;
        assert.strictEqual(
          where.result,
          path.join(config.stateDir, "plugin-data", id),
        );
        assert.isTrue(yield* fs.exists(path.join(config.stateDir, "plugin-data", id)));
        const missing = yield* store.call(id, "absent", null).pipe(Effect.flip);
        assert.strictEqual(missing.reason, "invalid");
        assert.isTrue((yield* store.list).plugins[0]?.enabled);
        // Loading it again (a hot reload) first runs the cleanup the old copy returned.
        const cleaned = path.join(config.stateDir, "plugin-data", id, "cleaned");
        assert.isFalse(yield* fs.exists(cleaned));
        yield* store.activateServerPlugins;
        assert.isTrue(yield* fs.exists(cleaned));
        assert.deepStrictEqual(yield* store.call(id, "double", 2), { ok: true, result: 4 });
      }),
    ),
  );

  it.effect("keeps a failure on the plugin until it is written again", () =>
    withPluginStore(
      Effect.gen(function* () {
        const store = yield* PluginStore.PluginStore;
        const id = "breaks-app" as PluginId;
        yield* store.write(id, [
          { path: "plugin.json", content: manifest(id) },
          { path: "client.js", content: "export default function activate() {}" },
        ]);
        const off = yield* store.setState(id, {
          failure: {
            at: "2026-11-14T00:00:00.000Z",
            phase: "client-runtime",
            message: "The plugin threw while running: boom",
          },
        });
        assert.isFalse(off.enabled);
        assert.strictEqual(off.failureAcknowledged, false);
        assert.strictEqual(off.failure?.phase, "client-runtime");

        // Acknowledging the failure saves the choice but does not move the revision.
        const beforeAck = (yield* store.list).revision;
        const acked = yield* store.setState(id, { acknowledge: true });
        assert.isTrue(acked.failureAcknowledged);
        assert.strictEqual((yield* store.list).revision, beforeAck);

        // A description edit alone does not turn the broken plugin back on.
        const edited = yield* store.write(id, [
          {
            path: "plugin.json",
            content: JSON.stringify({ id, name: "Renamed", version: "1.0.1" }),
          },
        ]);
        assert.isFalse(edited.plugin.enabled);

        // A broken plugin.json on disk: the write saves its file and reports the broken plugin, not an error.
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* pluginsDir;
        yield* fs.writeFileString(path.join(dir, id, "plugin.json"), "{ not json");
        const broken = yield* store.write(id, [
          { path: "client.js", content: "export default function activate() {}" },
        ]);
        assert.strictEqual(broken.plugin.failure?.phase, "manifest");

        const fixed = yield* store.write(id, [
          { path: "plugin.json", content: manifest(id) },
          { path: "client.js", content: "export default function activate() { /* fixed */ }" },
        ]);
        assert.isTrue(fixed.plugin.enabled);
        assert.isUndefined(fixed.plugin.failure);
      }),
    ),
  );

  it.effect("turns off a server.js that throws while the server starts", () =>
    withPluginStore(
      Effect.gen(function* () {
        const store = yield* PluginStore.PluginStore;
        const id = "server-thrower" as PluginId;
        yield* store.write(id, [
          { path: "plugin.json", content: manifest(id) },
          {
            path: "server.js",
            content: 'export default function activate() { throw new Error("server boom"); }',
          },
        ]);
        yield* store.activateServerPlugins;
        const listing = yield* store.list;
        const plugin = listing.plugins.find((entry) => entry.id === id);
        assert.isFalse(plugin?.enabled);
        assert.strictEqual(plugin?.failure?.phase, "server-activate");
        assert.include(plugin?.failure?.message ?? "", "server boom");
      }),
    ),
  );

  it.effect("turns off a server.js that never finishes starting, so the server can start", () =>
    withPluginStore(
      Effect.gen(function* () {
        const store = yield* PluginStore.PluginStore;
        const id = "hangs-start" as PluginId;
        // server.js reports when it starts, then never finishes. The clock moves only after that.
        const started = Promise.withResolvers<void>();
        Object.assign(globalThis, { pluginHangStarted: started.resolve });
        yield* store.write(id, [
          { path: "plugin.json", content: manifest(id) },
          {
            path: "server.js",
            content:
              "export default function activate() { globalThis.pluginHangStarted(); return new Promise(() => {}); }",
          },
        ]);
        const starting = yield* store.activateServerPlugins.pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust("15 seconds");
        yield* Fiber.join(starting);
        Reflect.deleteProperty(globalThis, "pluginHangStarted");
        const plugin = (yield* store.list).plugins.find((entry) => entry.id === id);
        assert.isFalse(plugin?.enabled);
        assert.strictEqual(plugin?.failure?.phase, "server-activate");
        assert.include(plugin?.failure?.message ?? "", "did not finish starting");
      }),
    ),
  );

  it.effect("turns off a plugin whose server start never finished", () =>
    withPluginStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* PluginStore.PluginStore;
        const id = "crashy" as PluginId;
        yield* store.write(id, [
          { path: "plugin.json", content: manifest(id) },
          { path: "server.js", content: "export default function activate() {}" },
        ]);
        // The state a server leaves behind when it dies while starting this plugin.
        const dir = yield* pluginsDir;
        yield* fs.writeFileString(
          path.join(dir, "state.json"),
          JSON.stringify({
            revision: 1,
            plugins: { [id]: { enabled: true, failureAcknowledged: true } },
            clientBootPending: [],
            serverBootPending: [id],
          }),
        );
        yield* store.activateServerPlugins;
        const listing = yield* store.list;
        const plugin = listing.plugins.find((entry) => entry.id === id);
        assert.isFalse(plugin?.enabled);
        assert.strictEqual(plugin?.failure?.phase, "server-boot");
      }),
    ),
  );

  it.effect(
    "boot bookkeeping does not move the revision, and a page confirms only its plugins",
    () =>
      withPluginStore(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* PluginStore.PluginStore;
          for (const id of ["boot-a", "boot-b"] as const) {
            yield* store.write(id as PluginId, [
              { path: "plugin.json", content: manifest(id) },
              { path: "client.js", content: "export default function activate() {}" },
            ]);
          }
          const before = (yield* store.list).revision;
          yield* store.clientBootStart(["boot-a" as PluginId, "boot-b" as PluginId]);
          yield* store.clientBootOk(["boot-a" as PluginId]);
          assert.strictEqual((yield* store.list).revision, before);
          const dir = yield* pluginsDir;
          const state = JSON.parse(yield* fs.readFileString(path.join(dir, "state.json")));
          assert.deepStrictEqual(
            state.clientBootPending.map((entry: { id: string }) => entry.id),
            ["boot-b"],
          );
        }),
      ),
  );

  it.effect("turns off a plugin a page never confirmed, and reloading replaces its entry", () =>
    withPluginStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* PluginStore.PluginStore;
        const id = "stuck-page" as PluginId;
        yield* store.write(id, [
          { path: "plugin.json", content: manifest(id) },
          { path: "client.js", content: "export default function activate() {}" },
        ]);
        const dir = yield* pluginsDir;
        // A page loaded this plugin two minutes before "now" (the test clock starts at 0) and never confirmed.
        yield* fs.writeFileString(
          path.join(dir, "state.json"),
          JSON.stringify({
            revision: 1,
            plugins: { [id]: { enabled: true, failureAcknowledged: true } },
            clientBootPending: [{ id, startedAt: -120_000, build: "build-1" }],
            serverBootPending: [],
          }),
        );
        yield* store.clientBootStart(["other-plugin" as PluginId]);
        const plugin = (yield* store.list).plugins.find((entry) => entry.id === id);
        assert.isFalse(plugin?.enabled);
        assert.strictEqual(plugin?.failure?.phase, "client-boot");
        // The crashed build is kept, so only another build retries the plugin.
        assert.strictEqual(plugin?.failure?.build, "build-1");
      }),
    ),
  );

  it.effect("lists a plugin whose plugin.json cannot be read as turned off, with the reason", () =>
    withPluginStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* PluginStore.PluginStore;
        const dir = yield* pluginsDir;
        yield* fs.makeDirectory(path.join(dir, "bad-json"), { recursive: true });
        yield* fs.writeFileString(path.join(dir, "bad-json", "plugin.json"), "{ not json");
        const plugin = (yield* store.list).plugins.find((entry) => entry.id === "bad-json");
        assert.isFalse(plugin?.enabled);
        assert.strictEqual(plugin?.failure?.phase, "manifest");
        assert.include(plugin?.failure?.message ?? "", "Fix plugin.json");
      }),
    ),
  );

  it.effect("refuses a write over the folder size limit and writes nothing", () =>
    withPluginStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* PluginStore.PluginStore;
        const id = "too-big" as PluginId;
        yield* store.write(id, [{ path: "plugin.json", content: manifest(id) }]);
        // A leftover file the store does not manage fills most of the 64 MB folder limit.
        const dir = yield* pluginsDir;
        yield* fs.writeFileString(path.join(dir, id, "leftover.bin"), "x".repeat(66_800_000));
        const error = yield* store
          .write(id, [{ path: "client.js", content: "y".repeat(512 * 1024) }])
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid");
        const missing = yield* store.readFile(id, "client.js").pipe(Effect.flip);
        assert.strictEqual(missing.reason, "not_found");
        // A file too big for a write, put there by hand, is not read back either.
        yield* fs.writeFileString(path.join(dir, id, "client.js"), "y".repeat(2 * 1024 * 1024 + 10));
        const oversized = yield* store.readFile(id, "client.js").pipe(Effect.flip);
        assert.strictEqual(oversized.reason, "invalid");
      }),
    ),
  );

  it.effect("sets a damaged state file aside instead of silently resetting it", () =>
    withPluginStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* PluginStore.PluginStore;
        const dir = yield* pluginsDir;
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.writeFileString(path.join(dir, "state.json"), "{ damaged");
        yield* store.list;
        const names = yield* fs.readDirectory(dir);
        assert.isTrue(names.some((name) => name.startsWith("state.json.damaged-")));
      }),
    ),
  );

  it.effect("removing a plugin moves the revision so open pages refresh", () =>
    withPluginStore(
      Effect.gen(function* () {
        const store = yield* PluginStore.PluginStore;
        const id = "gone-soon" as PluginId;
        yield* store.write(id, [
          { path: "plugin.json", content: manifest(id) },
          { path: "client.js", content: "export default function activate() {}" },
        ]);
        const before = (yield* store.list).revision;
        yield* store.remove(id);
        const after = yield* store.list;
        assert.isTrue(after.revision > before);
        assert.isUndefined(after.plugins.find((entry) => entry.id === id));
      }),
    ),
  );
});
