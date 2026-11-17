// @effect-diagnostics nodeBuiltinImport:off -- the app archive only answers synchronous fs calls, not Effect's async ones.
import * as NodeFS from "node:fs";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

/** Plugins that ship inside the app. A plugin with a native addon lists the one platform it runs on. */
const BUNDLED_PLUGINS: ReadonlyArray<{
  readonly id: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}> = [
  { id: "app-launcher" },
  { id: "t3-sync" },
  { id: "jperformance", platform: "win32", arch: "x64" },
];

/** Seeded switched off: it reads the T3 Code database, so the user turns it on. */
export const STARTS_DISABLED: ReadonlySet<string> = new Set(["t3-sync"]);

/** Sync node:fs, because inside the packaged server.asar directories fail the async calls. */
const bundledExists = (target: string) => NodeFS.existsSync(target);
const copyTree = (from: string, to: string) =>
  Effect.try({
    try: () => {
      const walk = (a: string, b: string) => {
        NodeFS.mkdirSync(b, { recursive: true });
        for (const entry of NodeFS.readdirSync(a, { withFileTypes: true })) {
          const next = [a + "/" + entry.name, b + "/" + entry.name] as const;
          if (entry.isDirectory()) walk(...next);
          else NodeFS.copyFileSync(...next);
        }
      };
      walk(from, to);
    },
    catch: (cause) =>
      new BundledPluginCopyError({
        message: `Copying bundled plugin ${from} failed: ${String(cause)}`,
      }),
  });

class BundledPluginCopyError extends Schema.TaggedError<BundledPluginCopyError>()(
  "BundledPluginCopyError",
  { message: Schema.String },
) {}

const MARKER = ".bundled-seeded.json";
const SeededIds = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeSeededIds = Schema.decodeUnknownEffect(SeededIds);
const encodeSeededIds = Schema.encodeEffect(SeededIds);

/**
 * Copies the plugins that ship with the app into the plugins folder, once each. A folder that
 * already exists is never touched, and an id in the marker is never copied again, so a plugin
 * the user deleted stays deleted.
 */
export const seedBundledPlugins = Effect.fn("seedBundledPlugins")(function* (sourceDir?: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const source = sourceDir ?? path.join(import.meta.dirname, "bundled-plugins");
  if (!bundledExists(source)) return [];

  const pluginsDir = path.join(config.stateDir, "plugins");
  const markerPath = path.join(pluginsDir, MARKER);
  yield* fs.makeDirectory(pluginsDir, { recursive: true });
  const seeded = yield* fs.readFileString(markerPath).pipe(
    Effect.flatMap(decodeSeededIds),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const done = new Set(seeded);
  const copied: Array<string> = [];
  for (const plugin of BUNDLED_PLUGINS) {
    if (done.has(plugin.id)) continue;
    if (plugin.platform !== undefined && plugin.platform !== platform) continue;
    if (plugin.arch !== undefined && plugin.arch !== arch) continue;
    const from = path.join(source, plugin.id);
    if (!bundledExists(from)) continue;
    done.add(plugin.id);
    const to = path.join(pluginsDir, plugin.id);
    if (yield* exists(to)) continue;
    yield* copyTree(from, to);
    copied.push(plugin.id);
  }
  yield* fs.writeFileString(markerPath, `${yield* encodeSeededIds([...done].toSorted())}\n`);
  return copied;
});
