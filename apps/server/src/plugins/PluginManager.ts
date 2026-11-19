// @effect-diagnostics nodeBuiltinImport:off - guarded plugin reads need lstat/open
// flags the FileSystem service does not expose.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type PluginCapability,
  type PluginContributes,
  type PluginJournalEntry,
  type PluginJournalOperation,
  PluginManifest,
  type PluginRecord,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const decodePluginManifestExit = Schema.decodeUnknownExit(Schema.fromJsonString(PluginManifest));

const MANIFEST_FILE = "plugin.json";
const STATE_FILE = "state.json";
const JOURNAL_FILE = "journal.jsonl";
const INSTALLED_DIR = "installed";
const SNAPSHOTS_DIR = "snapshots";
const TRASH_DIR = "trash";
const MAX_PLUGINS = 64;
const MAX_PLUGIN_FILES = 256;
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;
const MAX_PLUGIN_FILE_BYTES = 512 * 1024;
const MAX_PLUGIN_DEPTH = 8;
const MAX_JOURNAL_READ_BYTES = 1024 * 1024;
const MAX_SNAPSHOTS = 256;
const MAX_MANIFEST_BYTES = 64 * 1024;

/** Extensions a plugin may ship. Anything else is refused at install. */
const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".map",
  ".json",
  ".txt",
  ".md",
  ".woff",
  ".woff2",
  ".ttf",
]);
const IMAGE_ASSET_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"]);

/** The capability a contribution point needs. */
const CAPABILITY_FOR: {
  readonly [K in keyof Required<PluginContributes>]: PluginCapability;
} = {
  headerIcons: "ui:header-icon",
  panels: "ui:panel",
  themeCss: "ui:theme-css",
};

/** The manifest or its assets failed safety checks; the store was not touched. */
export class PluginRefusedError extends Schema.TaggedError<PluginRefusedError>()(
  "PluginRefusedError",
  {
    problem: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Plugin refused: ${this.problem}`;
  }
}

export class PluginNotFoundError extends Schema.TaggedError<PluginNotFoundError>()(
  "PluginNotFoundError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin "${this.pluginId}" is not installed.`;
  }
}

export class PluginRevertUnavailableError extends Schema.TaggedError<PluginRevertUnavailableError>()(
  "PluginRevertUnavailableError",
  { pluginId: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.pluginId === undefined
      ? "There is no plugin operation to revert."
      : `There is no revertable operation for plugin "${this.pluginId}".`;
  }
}

export class PluginInternalError extends Schema.TaggedError<PluginInternalError>()(
  "PluginInternalError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin operation "${this.operation}" failed.`;
  }
}

export type PluginError =
  | PluginRefusedError
  | PluginNotFoundError
  | PluginRevertUnavailableError
  | PluginInternalError;

const isExpectedRevertCause = Schema.is(
  Schema.Union([PluginRefusedError, PluginNotFoundError, PluginRevertUnavailableError]),
);

/** The plugin's own declared assets must be reachable without leaving its directory. */
const CAPABILITY_EXTENSIONS: {
  readonly [K in keyof Required<PluginContributes>]: ReadonlySet<string>;
} = {
  headerIcons: IMAGE_ASSET_EXTENSIONS,
  panels: new Set([".html", ".htm"]),
  themeCss: new Set([".css"]),
};

interface PluginStateEntry {
  readonly enabled: boolean;
  readonly source?: string;
  readonly installedAt: string;
  readonly updatedAt: string;
}

interface PluginStoreState {
  readonly version: 1;
  /** Monotonic sequence number shared by journal entries and snapshot names. */
  readonly seq: number;
  readonly plugins: Readonly<Record<string, PluginStateEntry>>;
}

interface StoredJournalEntry {
  readonly seq: number;
  readonly at: string;
  readonly operation: PluginJournalOperation;
  readonly pluginId: string;
  readonly detail?: string;
  /** Set on "revert" entries: the journal seq that was undone. */
  readonly revertedSeq?: number;
}

const pathIsTaken = (filePath: string): boolean => {
  try {
    NodeFS.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
};

const isSafeFileName = (name: string): boolean =>
  name.length > 0 && name !== "." && name !== ".." && !/[-/:*?"<>|]/.test(name);

/**
 * Reads one regular file with an upper bound; rejects symlinks, FIFOs and
 * oversized files. Returns null on any failure so callers can warn and skip.
 */
const readPluginFileGuarded = (filePath: string, maxBytes: number): string | null => {
  let fd: number;
  try {
    const stat = NodeFS.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    fd = NodeFS.openSync(
      filePath,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const info = NodeFS.fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const contents = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = NodeFS.readSync(fd, contents, offset, contents.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return new TextDecoder().decode(contents.subarray(0, offset));
  } catch {
    return null;
  } finally {
    NodeFS.closeSync(fd);
  }
};

const collectPluginFiles = (
  root: string,
  limit: { files: number; bytes: number; problems: Array<string> },
  depth = 0,
): Array<{ relative: string; absolute: string; size: number }> => {
  const files: Array<{ relative: string; absolute: string; size: number }> = [];
  const walk = (dir: string, prefix: string, level: number): void => {
    if (level > MAX_PLUGIN_DEPTH) {
      limit.problems.push(`is deeper than ${MAX_PLUGIN_DEPTH} directory levels`);
      return;
    }
    let entries: Array<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      limit.problems.push(`has an unreadable directory at "${prefix || "."}"`);
      return;
    }
    for (const entry of entries) {
      if (limit.files > MAX_PLUGIN_FILES) return;
      const absolute = NodePath.join(dir, entry.name);
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!isSafeFileName(entry.name)) {
          limit.problems.push(`has an unsafe directory name "${relative}"`);
          continue;
        }
        walk(absolute, relative, level + 1);
        continue;
      }
      if (!entry.isFile()) {
        limit.problems.push(`ships a non-file entry "${relative}"`);
        continue;
      }
      if (!isSafeFileName(entry.name) || entry.name.includes("\\") || relative.includes("..")) {
        limit.problems.push(`has an unsafe file name "${relative}"`);
        continue;
      }
      const extension = NodePath.extname(entry.name).toLowerCase();
      if (!ALLOWED_ASSET_EXTENSIONS.has(extension)) {
        limit.problems.push(`ships "${relative}" of a type plugins may not carry`);
        continue;
      }
      let info: NodeFS.Stats;
      try {
        // lstat catches symlinks; readdir's Dirent cannot be trusted on Windows junctions.
        info = NodeFS.lstatSync(absolute);
        if (info.isSymbolicLink()) {
          limit.problems.push(`ships a symlink "${relative}"`);
          continue;
        }
      } catch {
        continue;
      }
      if (info.size > MAX_PLUGIN_FILE_BYTES) {
        limit.problems.push(`ships "${relative}" larger than ${MAX_PLUGIN_FILE_BYTES} bytes`);
        continue;
      }
      limit.files += 1;
      limit.bytes += info.size;
      files.push({ relative, absolute, size: info.size });
    }
  };
  walk(root, "", depth);
  return files;
};

const contributedAssets = (manifest: PluginManifest): Array<{ path: string; point: string }> => {
  const out: Array<{ path: string; point: string }> = [];
  const contributes = manifest.contributes;
  if (contributes === undefined) return out;
  for (const icon of contributes.headerIcons ?? []) {
    out.push({ path: icon.icon, point: "headerIcons" });
  }
  for (const panel of contributes.panels ?? []) {
    out.push({ path: panel.html, point: "panels" });
  }
  if (contributes.themeCss !== undefined) {
    out.push({ path: contributes.themeCss, point: "themeCss" });
  }
  return out;
};

const validateManifest = (raw: string): { manifest?: PluginManifest; problem?: string } => {
  const decoded = decodePluginManifestExit(raw);
  if (decoded._tag === "Failure") {
    return { problem: `its plugin.json is not a valid manifest (${Cause.pretty(decoded.cause)})` };
  }
  const manifest = decoded.value;
  const contributes = manifest.contributes;
  if (contributes === undefined) return { manifest };
  const capabilities = new Set(manifest.capabilities);
  for (const key of Object.keys(CAPABILITY_FOR) as Array<keyof PluginContributes>) {
    const value = contributes[key];
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!empty && !capabilities.has(CAPABILITY_FOR[key])) {
      return {
        problem: `contributes.${key} requires capability "${CAPABILITY_FOR[key]}", which the manifest does not declare`,
      };
    }
  }
  return { manifest };
};

const copyDirectory = (source: string, target: string): void => {
  NodeFS.mkdirSync(target, { recursive: true });
  for (const entry of NodeFS.readdirSync(source, { withFileTypes: true })) {
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else if (entry.isFile()) {
      NodeFS.copyFileSync(from, to);
    }
  }
};

const removeDirectory = (target: string): void => {
  NodeFS.rmSync(target, { recursive: true, force: true });
};

export class PluginManagerService extends Context.Service<
  PluginManagerService,
  {
    readonly list: Effect.Effect<{
      readonly pluginsDir: string;
      readonly plugins: ReadonlyArray<PluginRecord>;
      readonly journal: ReadonlyArray<PluginJournalEntry>;
    }>;

    readonly install: (input: {
      readonly sourcePath: string;
      readonly enable?: boolean | undefined;
    }) => Effect.Effect<PluginRecord, PluginError>;

    readonly setEnabled: (
      pluginId: string,
      enabled: boolean,
    ) => Effect.Effect<PluginRecord, PluginError>;

    readonly remove: (pluginId: string) => Effect.Effect<void, PluginError>;

    /**
     * Undoes the most recent operation that is still revertable — the newest
     * journal entry not yet reverted — or that plugin's when `pluginId` is given.
     */
    readonly revert: (
      pluginId?: string,
    ) => Effect.Effect<
      { readonly reverted: PluginJournalOperation; readonly plugin?: PluginRecord },
      PluginError
    >;

    /**
     * Resolves one contributed asset inside an installed plugin for the HTTP
     * asset route; returns null when the plugin, file, or safety check fails.
     */
    readonly resolveAsset: (
      pluginId: string,
      assetPath: string,
    ) => Effect.Effect<{ readonly filePath: string; readonly size: number } | null>;
  }
>()("t3/plugins/PluginManager/PluginManagerService") {}

const make = Effect.gen(function* () {
  const { pluginsDir } = yield* ServerConfig.ServerConfig;
  const installedDir = NodePath.join(pluginsDir, INSTALLED_DIR);
  const snapshotsDir = NodePath.join(pluginsDir, SNAPSHOTS_DIR);
  const trashDir = NodePath.join(pluginsDir, TRASH_DIR);
  const statePath = NodePath.join(pluginsDir, STATE_FILE);
  const journalPath = NodePath.join(pluginsDir, JOURNAL_FILE);
  const mutex = yield* Semaphore.make(1);

  const internal = (operation: string, cause: unknown) =>
    new PluginInternalError({ operation, cause });

  const readState = (): PluginStoreState => {
    const raw = readPluginFileGuarded(statePath, 1024 * 1024);
    if (raw === null) return { version: 1, seq: 0, plugins: {} };
    try {
      const parsed = JSON.parse(raw) as PluginStoreState;
      if (parsed === null || typeof parsed !== "object" || parsed.version !== 1) {
        return { version: 1, seq: 0, plugins: {} };
      }
      return {
        version: 1,
        seq: typeof parsed.seq === "number" ? parsed.seq : 0,
        plugins: parsed.plugins ?? {},
      };
    } catch {
      return { version: 1, seq: 0, plugins: {} };
    }
  };

  const writeState = (state: PluginStoreState): void => {
    // Temp+rename keeps a torn write from losing every enabled flag.
    const temp = `${statePath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    NodeFS.renameSync(temp, statePath);
  };

  const readJournal = (): Array<StoredJournalEntry> => {
    const raw = readPluginFileGuarded(journalPath, MAX_JOURNAL_READ_BYTES);
    if (raw === null) return [];
    const entries: Array<StoredJournalEntry> = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as StoredJournalEntry;
        if (
          typeof parsed?.seq === "number" &&
          typeof parsed.operation === "string" &&
          typeof parsed.pluginId === "string"
        ) {
          entries.push(parsed);
        }
      } catch {
        // Tolerate a torn last line.
      }
    }
    return entries;
  };

  const appendJournal = (entry: Omit<StoredJournalEntry, "seq"> & { seq: number }): void => {
    NodeFS.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const readManifestFromDir = (dir: string): PluginManifest | null => {
    const raw = readPluginFileGuarded(NodePath.join(dir, MANIFEST_FILE), MAX_MANIFEST_BYTES);
    if (raw === null) return null;
    return validateManifest(raw).manifest ?? null;
  };

  const loadRecords = (): { state: PluginStoreState; plugins: Array<PluginRecord> } => {
    const state = readState();
    const plugins: Array<PluginRecord> = [];
    for (const [id, entry] of Object.entries(state.plugins)) {
      const manifest = readManifestFromDir(NodePath.join(installedDir, id));
      if (manifest === null || manifest.id !== id) continue;
      plugins.push({ manifest, ...entry });
    }
    plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return { state, plugins };
  };

  /** Validates a plugin directory about to be installed. */
  const checkPluginDir = (
    sourceDir: string,
  ): { manifest: PluginManifest; files: Array<{ relative: string; absolute: string }> } => {
    const manifestRaw = readPluginFileGuarded(
      NodePath.join(sourceDir, MANIFEST_FILE),
      MAX_MANIFEST_BYTES,
    );
    if (manifestRaw === null) {
      throw new PluginRefusedError({ problem: `has no readable ${MANIFEST_FILE}` });
    }
    const { manifest, problem } = validateManifest(manifestRaw);
    if (manifest === undefined) {
      throw new PluginRefusedError({ problem: problem ?? "has an invalid manifest" });
    }
    const limit = { files: 0, bytes: 0, problems: [] as Array<string> };
    const files = collectPluginFiles(sourceDir, limit);
    if (limit.problems.length > 0) {
      throw new PluginRefusedError({ problem: limit.problems[0] ?? "failed its safety scan" });
    }
    if (limit.bytes > MAX_PLUGIN_BYTES) {
      throw new PluginRefusedError({
        problem: `is larger than ${MAX_PLUGIN_BYTES} bytes in total`,
      });
    }
    // Every contributed asset must exist, stay inside the dir, and match its point's type.
    for (const asset of contributedAssets(manifest)) {
      if (asset.path.includes("..") || NodePath.isAbsolute(asset.path)) {
        throw new PluginRefusedError({
          problem: `contributes an unsafe asset path "${asset.path}"`,
        });
      }
      const extension = NodePath.extname(asset.path).toLowerCase();
      if (!CAPABILITY_EXTENSIONS[asset.point as keyof PluginContributes]?.has(extension)) {
        throw new PluginRefusedError({
          problem: `contributes.${asset.point} cannot use a ${extension || "extensionless"} asset ("${asset.path}")`,
        });
      }
      const absolute = NodePath.join(sourceDir, asset.path);
      let info: NodeFS.Stats;
      try {
        info = NodeFS.lstatSync(absolute);
      } catch {
        throw new PluginRefusedError({
          problem: `contributes missing asset "${asset.path}"`,
        });
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new PluginRefusedError({
          problem: `contributes asset "${asset.path}" that is not a regular file`,
        });
      }
    }
    return { manifest, files };
  };

  /** Copies a live plugin dir aside so the operation can be undone. */
  const snapshotPlugin = (seq: number, operation: string, pluginId: string): string | null => {
    const live = NodePath.join(installedDir, pluginId);
    if (!pathIsTaken(live)) return null;
    const name = `${seq}-${operation}-${pluginId}`;
    const target = NodePath.join(snapshotsDir, name);
    NodeFS.mkdirSync(snapshotsDir, { recursive: true });
    copyDirectory(live, target);
    // Bound retained history: drop the oldest snapshot dirs first.
    const snapshots = NodeFS.readdirSync(snapshotsDir).toSorted();
    while (snapshots.length > MAX_SNAPSHOTS) {
      const oldest = snapshots.shift();
      if (oldest === undefined) break;
      removeDirectory(NodePath.join(snapshotsDir, oldest));
    }
    return name;
  };

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const record = (
    seq: number,
    at: string,
    operation: PluginJournalOperation,
    pluginId: string,
    detail?: string,
    revertedSeq?: number,
  ): void => {
    appendJournal({
      seq,
      at,
      operation,
      pluginId,
      ...(detail === undefined ? {} : { detail }),
      ...(revertedSeq === undefined ? {} : { revertedSeq }),
    });
  };

  const list = Effect.sync(() => {
    const { plugins } = loadRecords();
    const journal = readJournal()
      .slice(-200)
      .map<PluginJournalEntry>(({ at, operation, pluginId, detail }) => ({
        at,
        operation,
        pluginId: pluginId as PluginJournalEntry["pluginId"],
        ...(detail === undefined ? {} : { detail }),
      }));
    return { pluginsDir, plugins, journal };
  });

  const installImpl = Effect.fn("plugins.install.impl")(function* (input: {
    readonly sourcePath: string;
    readonly enable?: boolean | undefined;
  }) {
    const sourceDir = yield* Effect.try({
      try: () => {
        const resolved = NodePath.resolve(input.sourcePath);
        const stat = NodeFS.statSync(resolved);
        if (!stat.isDirectory()) throw new Error("not a directory");
        return resolved;
      },
      catch: () => new PluginRefusedError({ problem: "sourcePath is not a readable directory" }),
    });
    if (sourceDir.startsWith(NodePath.resolve(pluginsDir) + NodePath.sep)) {
      return yield* new PluginRefusedError({
        problem: "cannot install from inside the plugins directory",
      });
    }
    const { manifest } = yield* Effect.try({
      try: () => checkPluginDir(sourceDir),
      catch: (error) => error as PluginRefusedError,
    });
    const pluginId = manifest.id;
    const state = readState();
    const existing = state.plugins[pluginId];
    if (Object.keys(state.plugins).length >= MAX_PLUGINS && existing === undefined) {
      return yield* new PluginRefusedError({
        problem: `the plugins store already holds ${MAX_PLUGINS} plugins`,
      });
    }
    const seq = state.seq + 1;
    const target = NodePath.join(installedDir, pluginId);
    const staging = NodePath.join(pluginsDir, `.installing-${seq}-${pluginId}`);
    yield* Effect.try({
      try: () => {
        NodeFS.mkdirSync(installedDir, { recursive: true });
        copyDirectory(sourceDir, staging);
        if (existing !== undefined && pathIsTaken(target)) {
          // Keep the overwritten version so install can be reverted.
          snapshotPlugin(seq, "install", pluginId);
        }
        removeDirectory(target);
        NodeFS.renameSync(staging, target);
      },
      catch: (cause) => {
        removeDirectory(staging);
        return internal("install", cause);
      },
    });
    const now = yield* nowIso;
    const entry: PluginStateEntry = {
      enabled: input.enable ?? existing?.enabled ?? true,
      ...(input.sourcePath === undefined ? {} : { source: input.sourcePath }),
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };
    yield* Effect.try({
      try: () => {
        writeState({
          version: 1,
          seq,
          plugins: { ...state.plugins, [pluginId]: entry },
        });
        record(seq, now, "install", pluginId, existing === undefined ? "installed" : "reinstalled");
      },
      catch: (cause) => internal("install", cause),
    });
    return { manifest, ...entry } satisfies PluginRecord;
  });

  const install = (input: { readonly sourcePath: string; readonly enable?: boolean | undefined }) =>
    mutex.withPermits(1)(installImpl(input));

  const setEnabledImpl = Effect.fn("plugins.setEnabled.impl")(function* (
    pluginId: string,
    enabled: boolean,
  ) {
    const state = readState();
    const entry = state.plugins[pluginId];
    if (entry === undefined) return yield* new PluginNotFoundError({ pluginId });
    const manifest = readManifestFromDir(NodePath.join(installedDir, pluginId));
    if (manifest === null) {
      return yield* new PluginRefusedError({
        problem: `its installed manifest cannot be revalidated`,
      });
    }
    if (entry.enabled === enabled) return { manifest, ...entry } satisfies PluginRecord;
    const seq = state.seq + 1;
    const now = yield* nowIso;
    const next: PluginStateEntry = { ...entry, enabled, updatedAt: now };
    yield* Effect.try({
      try: () => {
        writeState({ version: 1, seq, plugins: { ...state.plugins, [pluginId]: next } });
        record(seq, now, enabled ? "enable" : "disable", pluginId);
      },
      catch: (cause) => internal(enabled ? "enable" : "disable", cause),
    });
    return { manifest, ...next } satisfies PluginRecord;
  });

  const setEnabled = (pluginId: string, enabled: boolean) =>
    mutex.withPermits(1)(setEnabledImpl(pluginId, enabled));

  const removeImpl = Effect.fn("plugins.remove.impl")(function* (pluginId: string) {
    const state = readState();
    const entry = state.plugins[pluginId];
    if (entry === undefined) return yield* new PluginNotFoundError({ pluginId });
    const seq = state.seq + 1;
    const live = NodePath.join(installedDir, pluginId);
    const now = yield* nowIso;
    yield* Effect.try({
      try: () => {
        NodeFS.mkdirSync(trashDir, { recursive: true });
        // Keep the files: revert restores them from the trash copy.
        if (pathIsTaken(live)) {
          const trashTarget = NodePath.join(trashDir, `${seq}-${pluginId}`);
          NodeFS.renameSync(live, trashTarget);
        }
        const plugins = { ...state.plugins };
        delete plugins[pluginId];
        writeState({ version: 1, seq, plugins });
        record(seq, now, "remove", pluginId);
      },
      catch: (cause) => internal("remove", cause),
    });
  });

  const remove = (pluginId: string) => mutex.withPermits(1)(removeImpl(pluginId));

  const revertImpl = Effect.fn("plugins.revert.impl")(function* (pluginId?: string) {
    const journal = readJournal();
    const reverted = new Set(
      journal.filter((entry) => entry.revertedSeq !== undefined).map((entry) => entry.revertedSeq),
    );
    const candidate = [...journal]
      .reverse()
      .find(
        (entry) =>
          entry.operation !== "revert" &&
          !reverted.has(entry.seq) &&
          (pluginId === undefined || entry.pluginId === pluginId),
      );
    if (candidate === undefined) {
      return yield* new PluginRevertUnavailableError({ pluginId });
    }
    const state = readState();
    const seq = state.seq + 1;
    const now = yield* nowIso;
    yield* Effect.try({
      try: () => {
        switch (candidate.operation) {
          case "install": {
            removeDirectory(NodePath.join(installedDir, candidate.pluginId));
            const snapshot = NodePath.join(
              snapshotsDir,
              `${candidate.seq}-install-${candidate.pluginId}`,
            );
            if (pathIsTaken(snapshot)) {
              // The install overwrote an earlier version; bring it back.
              NodeFS.renameSync(snapshot, NodePath.join(installedDir, candidate.pluginId));
            }
            if (!pathIsTaken(NodePath.join(installedDir, candidate.pluginId))) {
              const plugins = { ...state.plugins };
              delete plugins[candidate.pluginId];
              writeState({ version: 1, seq, plugins });
            } else {
              writeState({ version: 1, seq, plugins: state.plugins });
            }
            break;
          }
          case "enable": {
            const entry = state.plugins[candidate.pluginId];
            if (entry === undefined) {
              throw new PluginNotFoundError({ pluginId: candidate.pluginId });
            }
            writeState({
              version: 1,
              seq,
              plugins: {
                ...state.plugins,
                [candidate.pluginId]: { ...entry, enabled: false, updatedAt: now },
              },
            });
            break;
          }
          case "disable": {
            const entry = state.plugins[candidate.pluginId];
            if (entry === undefined) {
              throw new PluginNotFoundError({ pluginId: candidate.pluginId });
            }
            writeState({
              version: 1,
              seq,
              plugins: {
                ...state.plugins,
                [candidate.pluginId]: { ...entry, enabled: true, updatedAt: now },
              },
            });
            break;
          }
          case "remove": {
            const trash = NodePath.join(trashDir, `${candidate.seq}-${candidate.pluginId}`);
            if (!pathIsTaken(trash)) {
              throw new PluginRefusedError({
                problem: `the removed plugin's backup is gone; it cannot be reverted`,
              });
            }
            NodeFS.mkdirSync(installedDir, { recursive: true });
            NodeFS.renameSync(trash, NodePath.join(installedDir, candidate.pluginId));
            const manifest = readManifestFromDir(NodePath.join(installedDir, candidate.pluginId));
            if (manifest === null) {
              throw new PluginRefusedError({
                problem: `the restored plugin's manifest no longer validates`,
              });
            }
            // Rebuild the state entry; the pre-remove enabled flag is unknown, so restore enabled.
            writeState({
              version: 1,
              seq,
              plugins: {
                ...state.plugins,
                [candidate.pluginId]: { enabled: true, installedAt: now, updatedAt: now },
              },
            });
            break;
          }
          default:
            throw new PluginRevertUnavailableError({ pluginId });
        }
        record(
          seq,
          now,
          "revert",
          candidate.pluginId,
          `undid ${candidate.operation}`,
          candidate.seq,
        );
      },
      catch: (cause) =>
        isExpectedRevertCause(cause) ? (cause as PluginError) : internal("revert", cause),
    });
    const { plugins } = loadRecords();
    const plugin = plugins.find((entry) => entry.manifest.id === candidate.pluginId);
    return {
      reverted: candidate.operation,
      ...(plugin === undefined ? {} : { plugin }),
    };
  });

  const revert = (pluginId?: string) => mutex.withPermits(1)(revertImpl(pluginId));

  const resolveAsset = Effect.fn("plugins.resolveAsset")(function* (
    pluginId: string,
    assetPath: string,
  ) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,63})$/.test(pluginId)) return null;
    if (assetPath.includes("..") || assetPath.includes("\\") || assetPath.startsWith("/")) {
      return null;
    }
    const pluginDir = NodePath.join(installedDir, pluginId);
    const filePath = NodePath.join(pluginDir, assetPath);
    if (!filePath.startsWith(pluginDir + NodePath.sep)) return null;
    return yield* Effect.sync(() => {
      try {
        // Reject the whole chain if any link resolves outside the plugin dir.
        const real = NodeFS.realpathSync(filePath);
        const realPluginDir = NodeFS.realpathSync(pluginDir);
        if (real !== realPluginDir && !real.startsWith(realPluginDir + NodePath.sep)) return null;
        const info = NodeFS.statSync(real);
        if (!info.isFile() || info.size > MAX_PLUGIN_FILE_BYTES) return null;
        return { filePath: real, size: info.size };
      } catch {
        return null;
      }
    });
  });

  return PluginManagerService.of({
    list,
    install,
    setEnabled,
    remove,
    revert,
    resolveAsset,
  });
});

export const layer = Layer.effect(PluginManagerService, make);
