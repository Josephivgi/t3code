import {
  PLUGIN_FILE_NAMES,
  PluginFailure,
  type PluginCallResult,
  type PluginFileName,
  type PluginFilePath,
  type PluginFileResult,
  type PluginId,
  type PluginListResult,
  type PluginManifest,
  PluginManifest as PluginManifestSchema,
  type PluginStatePayload,
  type PluginSummary,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeURL from "node:url";

import * as ServerConfig from "../config.ts";

const MAX_PLUGINS = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Counts source and data files. Build output folders (`target`, `node_modules`) do not count. */
const MAX_PLUGIN_BYTES = 64 * 1024 * 1024;
const UNCOUNTED_FOLDERS = new Set(["target", "node_modules", ".git"]);
const MAX_LISTED_FILES = 500;
/** A page that has not confirmed its boot after this long counts as having failed to start. */
const CLIENT_BOOT_GRACE_MS = 60_000;
/** A server.js that has not finished starting after this long is turned off, so the server can start. */
const SERVER_ACTIVATE_TIMEOUT_MS = 15_000;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PluginStateRecord = Schema.Struct({
  enabled: Schema.Boolean,
  failure: Schema.optionalKey(PluginFailure),
  failureAcknowledged: Schema.Boolean,
});
type PluginStateRecord = typeof PluginStateRecord.Type;

const PluginStateFile = Schema.Struct({
  revision: Schema.Number,
  plugins: Schema.Record(Schema.String, PluginStateRecord),
  clientBootPending: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      startedAt: Schema.Number,
      build: Schema.optionalKey(Schema.String),
    }),
  ),
  serverBootPending: Schema.Array(Schema.String),
});
type PluginStateFile = typeof PluginStateFile.Type;

const EMPTY_STATE: PluginStateFile = {
  revision: 0,
  plugins: {},
  clientBootPending: [],
  serverBootPending: [],
};

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifestSchema));
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginStateFile));
const encodeState = Schema.encodeEffect(fromJsonStringPretty(PluginStateFile));

export class PluginStoreError extends Schema.TaggedError<PluginStoreError>()("PluginStoreError", {
  reason: Schema.Literals(["not_found", "invalid", "io"]),
  message: Schema.String,
}) {}

/** A plugin's server.js threw while the server started it. */
class PluginActivationError extends Schema.TaggedError<PluginActivationError>()(
  "PluginActivationError",
  {
    message: Schema.String,
    stack: Schema.optionalKey(Schema.String),
  },
) {}

/** A method a plugin's server.js registered with `handle`. */
type PluginHandler = (args: unknown) => unknown;

export interface PluginWriteFile {
  readonly path: PluginFilePath;
  readonly content: string;
}

export interface PluginWriteResult {
  readonly plugin: PluginSummary;
  /** `server.js` changed; the server imports it again within a few seconds, no restart needed. */
  readonly restartRequired: boolean;
}

export class PluginStore extends Context.Service<
  PluginStore,
  {
    readonly list: Effect.Effect<PluginListResult, PluginStoreError>;
    readonly readFile: (
      id: PluginId,
      path: PluginFilePath,
    ) => Effect.Effect<PluginFileResult, PluginStoreError>;
    /** Paths of the files in a plugin folder, without build output folders. */
    readonly files: (id: PluginId) => Effect.Effect<ReadonlyArray<string>, PluginStoreError>;
    /** Runs a method the plugin's server.js registered. A handler that throws returns ok: false. */
    readonly call: (
      id: PluginId,
      method: string,
      args: unknown,
    ) => Effect.Effect<PluginCallResult, PluginStoreError>;
    /** Creates or replaces files. A write re-enables the plugin and clears its failure. */
    readonly write: (
      id: PluginId,
      files: ReadonlyArray<PluginWriteFile>,
    ) => Effect.Effect<PluginWriteResult, PluginStoreError>;
    readonly setState: (
      id: PluginId,
      payload: PluginStatePayload,
    ) => Effect.Effect<PluginSummary, PluginStoreError>;
    readonly remove: (id: PluginId) => Effect.Effect<void, PluginStoreError>;
    readonly clientBootStart: (
      ids: ReadonlyArray<PluginId>,
      build?: string,
    ) => Effect.Effect<void, PluginStoreError>;
    readonly clientBootOk: (ids: ReadonlyArray<PluginId>) => Effect.Effect<void, PluginStoreError>;
    /** Runs at server start: disables plugins that broke the last start, then loads the rest. */
    readonly activateServerPlugins: Effect.Effect<void, PluginStoreError>;
    /** Never returns: re-applies plugin files that change on disk, so development needs no restart. */
    readonly watchServerPlugins: Effect.Effect<never, PluginStoreError>;
  }
>()("t3/plugins/PluginStore") {}

const isSafeRelativePath = (value: string) =>
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const failureRecord = (
  at: string,
  phase: PluginFailure["phase"],
  message: string,
  stack?: string,
): PluginFailure => ({
  at,
  phase,
  message,
  ...(stack === undefined ? {} : { stack }),
});

const sameRecord = (
  a: PluginStateRecord | undefined,
  b: PluginStateRecord | undefined,
  // Acknowledging a failure changes no code the page runs, so it does not count as a change.
  { acknowledgement = true }: { readonly acknowledgement?: boolean } = {},
) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.enabled === b.enabled &&
    (!acknowledgement || a.failureAcknowledged === b.failureAcknowledged) &&
    a.failure?.at === b.failure?.at &&
    a.failure?.phase === b.failure?.phase &&
    a.failure?.message === b.failure?.message);

const samePlugins = (
  a: Readonly<Record<string, PluginStateRecord>>,
  b: Readonly<Record<string, PluginStateRecord>>,
  options?: { readonly acknowledgement?: boolean },
) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every((id) =>
    sameRecord(a[id], b[id], options),
  );

export const layer = Layer.effect(
  PluginStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);

    const pluginsDir = path.join(config.stateDir, "plugins");
    const statePath = path.join(pluginsDir, "state.json");
    const pluginDir = (id: PluginId) => path.join(pluginsDir, id);
    const fileExists = (filePath: string) =>
      fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    const ioError = (message: string) => (cause: unknown) =>
      new PluginStoreError({ reason: "io", message: `${message} ${errorMessage(cause)}` });
    const invalid = (message: string) => new PluginStoreError({ reason: "invalid", message });
    const dataRoot = path.join(config.stateDir, "plugin-data");
    const handlers = new Map<string, Map<string, PluginHandler>>();

    const readState = Effect.gen(function* () {
      if (!(yield* fileExists(statePath))) return EMPTY_STATE;
      const text = yield* fs
        .readFileString(statePath)
        .pipe(Effect.mapError(ioError("Reading plugin state failed.")));
      const decoded = yield* decodeState(text).pipe(Effect.option);
      if (decoded._tag === "Some") return decoded.value;
      // Keep the damaged file for inspection. The new revision tells open clients to refresh.
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      yield* fs
        .copyFile(statePath, `${statePath}.damaged-${nowMs}`)
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* Effect.logWarning("Plugin state was damaged, so it was set aside and reset.");
      return { ...EMPTY_STATE, revision: nowMs };
    });

    const writeState = Effect.fn("PluginStore.writeState")(function* (state: PluginStateFile) {
      yield* fs
        .makeDirectory(pluginsDir, { recursive: true })
        .pipe(Effect.mapError(ioError("Creating the plugins folder failed.")));
      const text = yield* encodeState(state).pipe(
        Effect.mapError(ioError("Encoding plugin state failed.")),
      );
      yield* fs
        .writeFileString(statePath, `${text}\n`)
        .pipe(Effect.mapError(ioError("Saving plugin state failed.")));
    });

    /**
     * Read-modify-write of the state file under one lock. The revision moves when a plugin's
     * state changes, so open clients reload; boot bookkeeping alone does not move it.
     */
    const updateState = Effect.fn("PluginStore.updateState")(function* (
      change: (state: PluginStateFile) => PluginStateFile,
      options: { readonly force?: boolean } = {},
    ) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          const current = yield* readState;
          const next = change(current);
          const changed =
            options.force === true ||
            !samePlugins(current.plugins, next.plugins, { acknowledgement: false });
          yield* writeState({
            ...next,
            revision: changed ? current.revision + 1 : current.revision,
          });
        }),
      );
    });

    const folderIds = fs.readDirectory(pluginsDir).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.map((names) => names.filter((name): name is PluginId => PLUGIN_ID_PATTERN.test(name))),
    );

    const readManifest = Effect.fn("PluginStore.readManifest")(function* (id: PluginId) {
      const text = yield* fs
        .readFileString(path.join(pluginDir(id), "plugin.json"))
        .pipe(Effect.mapError(ioError("Reading plugin.json failed.")));
      const manifest = yield* decodeManifest(text).pipe(
        Effect.mapError((cause) => invalid(`plugin.json is invalid: ${errorMessage(cause)}`)),
      );
      if (manifest.id !== id) {
        return yield* invalid(`plugin.json names id "${manifest.id}" but the folder is "${id}".`);
      }
      return manifest;
    });

    const summarize = Effect.fn("PluginStore.summarize")(function* (
      id: PluginId,
      manifest: PluginManifest,
      record: PluginStateRecord | undefined,
    ) {
      const has = (name: PluginFileName) => fileExists(path.join(pluginDir(id), name));
      return {
        id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description === undefined ? {} : { description: manifest.description }),
        supports: manifest.supports ?? ["azon"],
        enabled: record?.enabled ?? true,
        hasClient: yield* has("client.js"),
        hasStyle: yield* has("style.css"),
        hasServer: yield* has("server.js"),
        ...(record?.failure === undefined ? {} : { failure: record.failure }),
        failureAcknowledged: record?.failureAcknowledged ?? true,
      } satisfies PluginSummary;
    });

    const summaryFor = Effect.fn("PluginStore.summaryFor")(function* (
      id: PluginId,
      state: PluginStateFile,
    ) {
      const manifest = yield* readManifest(id);
      return yield* summarize(id, manifest, state.plugins[id]);
    });

    const requireExists = Effect.fn("PluginStore.requireExists")(function* (id: PluginId) {
      if (yield* fileExists(path.join(pluginDir(id), "plugin.json"))) return;
      return yield* new PluginStoreError({
        reason: "not_found",
        message: `No plugin named "${id}".`,
      });
    });

    /** Relative paths of a plugin folder's files, build output folders left out. */
    const walkFiles = Effect.fn("PluginStore.walkFiles")(function* (id: PluginId) {
      const found: string[] = [];
      const visit: (relative: string) => Effect.Effect<void> = Effect.fn("PluginStore.walkVisit")(
        function* (relative: string) {
          const names = yield* fs
            .readDirectory(path.join(pluginDir(id), relative))
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
          for (const name of names) {
            if (found.length >= MAX_LISTED_FILES) return;
            const entry = relative === "" ? name : `${relative}/${name}`;
            const info = yield* fs.stat(path.join(pluginDir(id), entry)).pipe(Effect.option);
            if (info._tag === "None") continue;
            if (info.value.type === "Directory") {
              if (!UNCOUNTED_FOLDERS.has(name)) yield* visit(entry);
            } else {
              found.push(entry);
            }
          }
        },
      );
      yield* visit("");
      return found as ReadonlyArray<string>;
    });

    /** Bytes in the plugin folder, leaving out files named in `replaced`. */
    const folderBytes = Effect.fn("PluginStore.folderBytes")(function* (
      id: PluginId,
      replaced: ReadonlyArray<string> = [],
    ) {
      let total = 0;
      for (const name of yield* walkFiles(id)) {
        if (replaced.includes(name)) continue;
        const info = yield* fs.stat(path.join(pluginDir(id), name)).pipe(Effect.option);
        if (info._tag === "Some") total += Number(info.value.size);
      }
      return total;
    });

    /** A listed folder whose plugin.json cannot be read still shows up, turned off, with the reason. */
    const brokenSummary = Effect.fn("PluginStore.brokenSummary")(function* (
      id: PluginId,
      error: PluginStoreError,
    ) {
      const has = (name: PluginFileName) => fileExists(path.join(pluginDir(id), name));
      return {
        id,
        name: id,
        version: "unknown",
        supports: ["azon"],
        enabled: false,
        hasClient: yield* has("client.js"),
        hasStyle: yield* has("style.css"),
        hasServer: yield* has("server.js"),
        failure: failureRecord(
          DateTime.formatIso(yield* DateTime.now),
          "manifest",
          `The plugin could not be read: ${error.message.replace(/\.$/, "")}. Fix plugin.json and save it again.`,
        ),
        failureAcknowledged: true,
      } satisfies PluginSummary;
    });

    const list: PluginStore["Service"]["list"] = Effect.gen(function* () {
      const state = yield* readState;
      const plugins: PluginSummary[] = [];
      for (const id of yield* folderIds) {
        const summary = yield* summaryFor(id, state).pipe(
          Effect.catch((error: PluginStoreError) => brokenSummary(id, error)),
        );
        plugins.push(summary);
      }
      return { revision: state.revision, plugins };
    });

    const readFile = Effect.fn("PluginStore.readFile")(function* (
      id: PluginId,
      filePath: PluginFilePath,
    ) {
      yield* requireExists(id);
      if (!isSafeRelativePath(filePath)) {
        return yield* invalid(`"${filePath}" is not a plugin path.`);
      }
      const onDisk = path.join(pluginDir(id), filePath);
      if (!(yield* fileExists(onDisk))) {
        return yield* new PluginStoreError({
          reason: "not_found",
          message: `${id} has no ${filePath}.`,
        });
      }
      const info = yield* fs
        .stat(onDisk)
        .pipe(Effect.mapError(ioError(`Reading ${filePath} failed.`)));
      if (Number(info.size) > MAX_FILE_BYTES) {
        return yield* invalid(`${filePath} is over ${MAX_FILE_BYTES / 1024} KB.`);
      }
      const content = yield* fs
        .readFileString(onDisk)
        .pipe(Effect.mapError(ioError(`Reading ${filePath} failed.`)));
      return { id, path: filePath, content };
    });

    const write = Effect.fn("PluginStore.write")(function* (
      id: PluginId,
      files: ReadonlyArray<PluginWriteFile>,
    ) {
      for (const file of files) {
        if (!isSafeRelativePath(file.path)) {
          return yield* invalid(`"${file.path}" is not a plugin path.`);
        }
        if (new TextEncoder().encode(file.content).byteLength > MAX_FILE_BYTES) {
          return yield* invalid(`${file.path} is over ${MAX_FILE_BYTES / 1024} KB.`);
        }
      }
      const incoming = new Map(files.map((file) => [file.path, file.content] as const));

      return yield* lock.withPermit(
        Effect.gen(function* () {
          const isNew = !(yield* fileExists(path.join(pluginDir(id), "plugin.json")));
          if (isNew) {
            if (!incoming.has("plugin.json")) {
              return yield* invalid("A new plugin needs plugin.json.");
            }
            if ((yield* folderIds).length >= MAX_PLUGINS) {
              return yield* invalid(`The limit is ${MAX_PLUGINS} plugins.`);
            }
          }
          const manifestText = incoming.get("plugin.json");
          if (manifestText !== undefined) {
            const manifest = yield* decodeManifest(manifestText).pipe(
              Effect.mapError((cause) => invalid(`plugin.json is invalid: ${errorMessage(cause)}`)),
            );
            if (manifest.id !== id) {
              return yield* invalid(`plugin.json must name id "${id}".`);
            }
          }
          // Check the size before writing, so a refused write leaves the folder as it was.
          const incomingBytes = [...incoming.values()].reduce(
            (total, content) => total + new TextEncoder().encode(content).byteLength,
            0,
          );
          const keptBytes = yield* folderBytes(id, [...incoming.keys()]);
          if (keptBytes + incomingBytes > MAX_PLUGIN_BYTES) {
            return yield* invalid(
              `The plugin would be over ${MAX_PLUGIN_BYTES / 1024 / 1024} MB. Remove some files and try again.`,
            );
          }
          const current = yield* readState;
          // Code or styles written again turn the plugin on with the fix. A plugin.json-only write
          // keeps its state, so editing a description does not revive a plugin that broke.
          const writesCode = [...incoming.keys()].some((name) => name !== "plugin.json");
          const record: PluginStateRecord =
            writesCode || isNew || current.plugins[id] === undefined
              ? { enabled: true, failureAcknowledged: true }
              : current.plugins[id];
          // A write that changes nothing does not move the revision, so open pages are not told to reload.
          const onDiskSame = yield* Effect.forEach([...incoming], ([name, content]) =>
            fs.readFileString(path.join(pluginDir(id), name)).pipe(
              Effect.map((existing) => existing === content),
              Effect.orElseSucceed(() => false),
            ),
          );
          const unchanged =
            !isNew && onDiskSame.every(Boolean) && sameRecord(current.plugins[id], record);
          const next: PluginStateFile = unchanged
            ? current
            : {
                ...current,
                plugins: { ...current.plugins, [id]: record },
                revision: current.revision + 1,
              };
          if (!unchanged) {
            yield* fs
              .makeDirectory(pluginDir(id), { recursive: true })
              .pipe(Effect.mapError(ioError("Creating the plugin folder failed.")));
            for (const [name, content] of incoming) {
              yield* fs
                .makeDirectory(path.dirname(path.join(pluginDir(id), name)), { recursive: true })
                .pipe(Effect.mapError(ioError(`Creating the folder for ${name} failed.`)));
              yield* fs
                .writeFileString(path.join(pluginDir(id), name), content)
                .pipe(Effect.mapError(ioError(`Writing ${name} failed.`)));
            }
            yield* writeState(next);
          }
          return {
            plugin: yield* summaryFor(id, next).pipe(
              Effect.catch((error: PluginStoreError) => brokenSummary(id, error)),
            ),
            restartRequired: [...incoming.keys()].some(
              (name, index) => name === "server.js" && !onDiskSame[index],
            ),
          } satisfies PluginWriteResult;
        }),
      );
    });

    const files = Effect.fn("PluginStore.files")(function* (id: PluginId) {
      yield* requireExists(id);
      return yield* walkFiles(id);
    });

    const call = Effect.fn("PluginStore.call")(function* (
      id: PluginId,
      method: string,
      args: unknown,
    ) {
      yield* requireExists(id);
      const state = yield* readState;
      if (!(state.plugins[id]?.enabled ?? true)) {
        return yield* invalid(`The plugin "${id}" is turned off.`);
      }
      const handler = handlers.get(id)?.get(method);
      if (handler === undefined) {
        return yield* invalid(
          `The plugin "${id}" has no method "${method}". Its server.js registers methods with handle(), and loads when the server starts.`,
        );
      }
      return yield* Effect.promise(async (): Promise<PluginCallResult> => {
        try {
          return { ok: true, result: (await handler(args)) ?? null };
        } catch (cause) {
          return { ok: false, error: errorMessage(cause) };
        }
      });
    });

    const setState = Effect.fn("PluginStore.setState")(function* (
      id: PluginId,
      payload: PluginStatePayload,
    ) {
      yield* requireExists(id);
      yield* updateState((state) => {
        const previous: PluginStateRecord = state.plugins[id] ?? {
          enabled: true,
          failureAcknowledged: true,
        };
        const acknowledged = payload.acknowledge === true ? true : previous.failureAcknowledged;
        const record: PluginStateRecord = {
          // Recording a failure turns the plugin off, unless the same request turns it on.
          enabled: payload.enabled ?? (payload.failure !== undefined ? false : previous.enabled),
          // A failure stays on the plugin until it is turned back on or acknowledged.
          ...(payload.failure !== undefined
            ? { failure: payload.failure, failureAcknowledged: false }
            : previous.failure !== undefined && payload.enabled !== true
              ? { failure: previous.failure, failureAcknowledged: acknowledged }
              : { failureAcknowledged: acknowledged }),
        };
        return { ...state, plugins: { ...state.plugins, [id]: record } };
      });
      return yield* summaryFor(id, yield* readState);
    });

    const remove = Effect.fn("PluginStore.remove")(function* (id: PluginId) {
      yield* requireExists(id);
      yield* fs
        .remove(pluginDir(id), { recursive: true })
        .pipe(Effect.mapError(ioError("Deleting the plugin folder failed.")));
      yield* updateState(
        (state) => {
          const { [id]: _removed, ...plugins } = state.plugins;
          return { ...state, plugins };
        },
        { force: true },
      );
    });

    const clientBootStart = Effect.fn("PluginStore.clientBootStart")(function* (
      ids: ReadonlyArray<PluginId>,
      build?: string,
    ) {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const at = DateTime.formatIso(now);
      yield* updateState((state) => {
        const plugins = { ...state.plugins };
        // An entry that never confirmed a boot long ago means that page crashed or hung while loading.
        const stale = new Set<string>();
        for (const entry of state.clientBootPending) {
          if (nowMs - entry.startedAt <= CLIENT_BOOT_GRACE_MS) continue;
          stale.add(entry.id);
          const record = plugins[entry.id] ?? { enabled: true, failureAcknowledged: true };
          if (!record.enabled) continue;
          plugins[entry.id] = {
            enabled: false,
            failureAcknowledged: false,
            failure: {
              ...failureRecord(
                at,
                "client-boot",
                "The app did not confirm that it started with this plugin loaded. The page may have crashed or hung, or the server could not be reached, so the plugin was turned off. Check it, then turn it on again in Settings > Plugins.",
              ),
              // The build that crashed, so only a different build retries the plugin.
              ...(entry.build === undefined ? {} : { build: entry.build }),
            },
          };
        }
        // A page that loads a plugin again replaces its earlier pending entry.
        const kept = state.clientBootPending.filter(
          (entry) => !stale.has(entry.id) && !ids.includes(entry.id),
        );
        return {
          ...state,
          plugins,
          clientBootPending: [
            ...kept,
            ...ids.map((id) => ({
              id,
              startedAt: nowMs,
              ...(build === undefined ? {} : { build }),
            })),
          ],
        };
      });
    });

    /** Only the plugins this page loaded are confirmed; other pages' pending entries stay. */
    const clientBootOk = (ids: ReadonlyArray<PluginId>) =>
      updateState((state) => ({
        ...state,
        clientBootPending: state.clientBootPending.filter((entry) => !ids.includes(entry.id)),
      }));

    let importCounter = 0;
    const serverCleanups = new Map<string, () => unknown>();
    /** Imports server.js fresh (cache-busted), so a changed file replaces the old handlers. */
    const activateOne = Effect.fn("PluginStore.activateOne")(function* (id: PluginId) {
      const manifest = yield* readManifest(id).pipe(Effect.option);
      if (manifest._tag === "None") return;
      const logs: string[] = [];
      const methods = new Map<string, PluginHandler>();
      handlers.set(id, methods);
      const dataDir = path.join(dataRoot, id);
      yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(Effect.ignore);
      const failed = yield* Effect.tryPromise({
        try: async () => {
          // The old copy must free its ports and timers before the changed one starts.
          const previousCleanup = serverCleanups.get(id);
          serverCleanups.delete(id);
          if (previousCleanup !== undefined) {
            try {
              await previousCleanup();
            } catch (cause) {
              logs.push(`Cleanup of the previous server.js threw: ${errorMessage(cause)}`);
            }
          }
          const entry = await import(
            NodeURL.pathToFileURL(path.join(pluginDir(id), "server.js")).href +
              `?v=${++importCounter}`
          );
          if (typeof entry.default === "function") {
            const returned: unknown = await entry.default({
              id,
              name: manifest.value.name,
              version: manifest.value.version,
              log: (message: string) => logs.push(message),
              dir: pluginDir(id),
              dataDir,
              handle: (method: string, handler: PluginHandler) => {
                methods.set(method, handler);
              },
            });
            if (typeof returned === "function") serverCleanups.set(id, returned as () => unknown);
          }
        },
        catch: (cause) =>
          new PluginActivationError({
            message: errorMessage(cause),
            ...(cause instanceof Error && cause.stack !== undefined ? { stack: cause.stack } : {}),
          }),
      }).pipe(
        Effect.as(undefined),
        Effect.catch((error: PluginActivationError) => Effect.succeed(error)),
        Effect.timeoutOrElse({
          duration: SERVER_ACTIVATE_TIMEOUT_MS,
          orElse: () =>
            Effect.succeed(
              new PluginActivationError({
                message: `server.js did not finish starting within ${SERVER_ACTIVATE_TIMEOUT_MS / 1000} seconds.`,
              }),
            ),
        }),
      );
      for (const message of logs) {
        yield* Effect.logInfo(`[plugin ${id}] ${message}`);
      }
      if (failed !== undefined) {
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* updateState((current) => ({
          ...current,
          plugins: {
            ...current.plugins,
            [id]: {
              enabled: false,
              failureAcknowledged: false,
              failure: failureRecord(
                at,
                "server-activate",
                `server.js threw while starting, so the plugin was turned off: ${failed.message}`,
                failed.stack,
              ),
            },
          },
        }));
      }
    });

    const activateServerPlugins = Effect.gen(function* () {
      // Anything still listed here means the last server start never finished.
      const brokeLastStart = new Set((yield* readState).serverBootPending);
      if (brokeLastStart.size > 0) {
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* updateState((state) => {
          const plugins = { ...state.plugins };
          for (const id of brokeLastStart) {
            const record = plugins[id];
            if (record === undefined || !record.enabled) continue;
            plugins[id] = {
              enabled: false,
              failureAcknowledged: false,
              failure: failureRecord(
                at,
                "server-boot",
                "The server did not finish starting with this plugin loaded, so it was turned off so the server could start. Check its server.js, then turn it on again in Settings > Plugins.",
              ),
            };
          }
          return { ...state, plugins };
        });
      }

      const starting: PluginId[] = [];
      const state = yield* readState;
      for (const id of yield* folderIds) {
        if (!(state.plugins[id]?.enabled ?? true)) continue;
        if (yield* fileExists(path.join(pluginDir(id), "server.js"))) starting.push(id);
      }
      yield* updateState((current) => ({ ...current, serverBootPending: starting }));

      for (const id of starting) yield* activateOne(id);

      yield* updateState((current) => ({ ...current, serverBootPending: [] }));
    });

    /**
     * Dev loop: files in a plugin folder that change on disk apply without a restart. A changed
     * server.js is imported again, and the revision moves so open pages reload the plugin.
     */
    const watchServerPlugins = Effect.gen(function* () {
      const signatures = new Map<string, string>();
      const scan = Effect.gen(function* () {
        const changedIds: PluginId[] = [];
        for (const id of yield* folderIds) {
          const entries: string[] = [];
          // Only the four plugin files; data a plugin writes into its folder must not reload it.
          for (const name of PLUGIN_FILE_NAMES) {
            const info = yield* fs.stat(path.join(pluginDir(id), name)).pipe(Effect.option);
            if (info._tag === "Some") {
              const mtime = Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0;
              entries.push(`${name}:${mtime}:${info.value.size}`);
            }
          }
          const signature = entries.sort().join("|");
          const previous = signatures.get(id);
          signatures.set(id, signature);
          if (previous !== undefined && previous !== signature) changedIds.push(id);
        }
        return changedIds;
      });
      yield* scan;
      while (true) {
        yield* Effect.sleep("1 second");
        const changed = yield* scan.pipe(Effect.orElseSucceed((): PluginId[] => []));
        for (const id of changed) {
          // Changed code gets a fresh start, as a write through the API does.
          yield* updateState(
            (state) => ({
              ...state,
              plugins: { ...state.plugins, [id]: { enabled: true, failureAcknowledged: true } },
            }),
            { force: true },
          ).pipe(Effect.ignore);
          if (yield* fileExists(path.join(pluginDir(id), "server.js"))) {
            yield* activateOne(id).pipe(Effect.ignore);
          }
        }
      }
    });

    return PluginStore.of({
      list,
      readFile,
      files,
      call,
      write,
      setState,
      remove,
      clientBootStart,
      clientBootOk,
      activateServerPlugins,
      watchServerPlugins,
    });
  }),
);
