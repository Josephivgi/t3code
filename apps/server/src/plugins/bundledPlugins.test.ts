import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { seedBundledPlugins } from "./bundledPlugins.ts";

const run = (platform: NodeJS.Platform, arch: NodeJS.Architecture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "azon-seed-" });
    const source = path.join(base, "bundled");
    for (const id of ["app-launcher", "t3-sync", "jperformance"]) {
      yield* fs.makeDirectory(path.join(source, id), { recursive: true });
      yield* fs.writeFileString(path.join(source, id, "plugin.json"), `{"id":"${id}"}`);
    }
    const layer = ServerConfig.layerTest(process.cwd(), path.join(base, "state"));
    const state = yield* ServerConfig.ServerConfig.pipe(
      Effect.map((config) => config.stateDir),
      Effect.provide(layer),
    );
    const seed = seedBundledPlugins(source).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, arch),
    );
    return { fs, path, state, seed };
  });

it.effect("seeds once, skips other platforms, keeps existing and deleted plugins", () =>
  Effect.gen(function* () {
    const { fs, path, state, seed } = yield* run("linux", "x64");
    const plugins = path.join(state, "plugins");
    yield* fs.makeDirectory(path.join(plugins, "t3-sync"), { recursive: true });
    yield* fs.writeFileString(path.join(plugins, "t3-sync", "plugin.json"), "mine");
    assert.deepStrictEqual(yield* seed, ["app-launcher"]);
    assert.isTrue(yield* fs.exists(path.join(plugins, "app-launcher", "plugin.json")));
    assert.isFalse(yield* fs.exists(path.join(plugins, "jperformance")));
    assert.strictEqual(
      yield* fs.readFileString(path.join(plugins, "t3-sync", "plugin.json")),
      "mine",
    );
    yield* fs.remove(path.join(plugins, "app-launcher"), { recursive: true });
    yield* seed;
    assert.isFalse(yield* fs.exists(path.join(plugins, "app-launcher")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("seeds the Windows-only plugin on win32 x64", () =>
  Effect.gen(function* () {
    const { fs, path, state, seed } = yield* run("win32", "x64");
    yield* seed;
    assert.isTrue(yield* fs.exists(path.join(state, "plugins", "jperformance", "plugin.json")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
