import * as Schema from "effect/Schema";

/** The files Azon Beta itself loads. A plugin folder may hold any other files beside them. */
export const PLUGIN_FILE_NAMES = ["plugin.json", "client.js", "style.css", "server.js"] as const;
export const PluginFileName = Schema.Literals(PLUGIN_FILE_NAMES);
export type PluginFileName = typeof PluginFileName.Type;

/** A path inside a plugin folder: segments of letters, digits, dot, dash and underscore, no `..`. */
export const PluginFilePath = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/),
);
export type PluginFilePath = typeof PluginFilePath.Type;

export const PluginId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
export type PluginId = typeof PluginId.Type;

export const PluginPhase = Schema.Literals([
  "client-activate",
  "client-runtime",
  "client-boot",
  "server-activate",
  "server-boot",
  "manifest",
]);
export type PluginPhase = typeof PluginPhase.Type;

/** Why a plugin was turned off. Written when it fails, shown to the person and to agents. */
/** Identifies one client build. A page failure recorded by another build is retried once. */
export const PluginClientBuild = Schema.String.check(Schema.isMaxLength(64));

export const PluginFailure = Schema.Struct({
  at: Schema.String,
  phase: PluginPhase,
  message: Schema.String,
  stack: Schema.optionalKey(Schema.String),
  build: Schema.optionalKey(PluginClientBuild),
});
export type PluginFailure = typeof PluginFailure.Type;

/** Which app a plugin is made for. A plugin without `supports` is Azon only. */
export const PluginSupport = Schema.Literals(["t3code", "azon"]);
export type PluginSupport = typeof PluginSupport.Type;

export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  version: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
  supports: Schema.optionalKey(Schema.Array(PluginSupport).check(Schema.isMinLength(1))),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginSummary = Schema.Struct({
  id: PluginId,
  name: Schema.String,
  version: Schema.String,
  description: Schema.optionalKey(Schema.String),
  supports: Schema.Array(PluginSupport),
  enabled: Schema.Boolean,
  hasClient: Schema.Boolean,
  hasStyle: Schema.Boolean,
  hasServer: Schema.Boolean,
  failure: Schema.optionalKey(PluginFailure),
  failureAcknowledged: Schema.Boolean,
});
export type PluginSummary = typeof PluginSummary.Type;

export const PluginListResult = Schema.Struct({
  /** Bumps on every change, so an open client can tell its copy is stale. */
  revision: Schema.Number,
  plugins: Schema.Array(PluginSummary),
});
export type PluginListResult = typeof PluginListResult.Type;

export const PluginFileResult = Schema.Struct({
  id: PluginId,
  path: PluginFilePath,
  content: Schema.String,
});
export type PluginFileResult = typeof PluginFileResult.Type;

export const PluginStatePayload = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  acknowledge: Schema.optionalKey(Schema.Boolean),
  failure: Schema.optionalKey(PluginFailure),
});
export type PluginStatePayload = typeof PluginStatePayload.Type;

export const PluginBootIds = Schema.Array(PluginId).check(Schema.isMaxLength(64));

export const PluginBootStartPayload = Schema.Struct({
  ids: PluginBootIds,
  build: Schema.optionalKey(PluginClientBuild),
});
export type PluginBootStartPayload = typeof PluginBootStartPayload.Type;

export const PluginBootOkPayload = Schema.Struct({
  ids: PluginBootIds,
});
export type PluginBootOkPayload = typeof PluginBootOkPayload.Type;

/** A page calling a method its plugin's server.js registered with `handle`. */
export const PluginCallPayload = Schema.Struct({
  method: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  args: Schema.optionalKey(Schema.Unknown),
});
export type PluginCallPayload = typeof PluginCallPayload.Type;

export const PluginCallResult = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optionalKey(Schema.Unknown),
  /** What the handler threw. A failing call never turns the plugin off. */
  error: Schema.optionalKey(Schema.String),
});
export type PluginCallResult = typeof PluginCallResult.Type;
