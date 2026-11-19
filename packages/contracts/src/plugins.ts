import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Declarative extension packages under the server's plugins directory. They
 * contribute UI assets only; `capabilities` is an enforced allowlist, and the
 * store is snapshotted before every mutation so operations can revert.
 */
export const PluginId = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,63})$/));
export type PluginId = typeof PluginId.Type;

export const PluginCapability = Schema.Literals([
  /** Renders `contributes.headerIcons` in the app header. */
  "ui:header-icon",
  /** Renders `contributes.panels` as sandboxed iframes. */
  "ui:panel",
  /** Applies `contributes.themeCss` to the app stylesheet. */
  "ui:theme-css",
]);
export type PluginCapability = typeof PluginCapability.Type;

/** Relative asset path inside the plugin directory: no `..`, no drive or root, no backslash. */
export const PluginAssetPath = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/),
);
export type PluginAssetPath = typeof PluginAssetPath.Type;

export const PluginHeaderIconContribution = Schema.Struct({
  /** Icon asset, SVG preferred. */
  icon: PluginAssetPath,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** Optional external URL opened in the system browser when clicked. */
  href: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type PluginHeaderIconContribution = typeof PluginHeaderIconContribution.Type;

export const PluginPanelContribution = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,63})$/)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** HTML asset rendered inside a sandboxed iframe. */
  html: PluginAssetPath,
});
export type PluginPanelContribution = typeof PluginPanelContribution.Type;

export const PluginContributes = Schema.Struct({
  headerIcons: Schema.optional(
    Schema.Array(PluginHeaderIconContribution).check(Schema.isMaxLength(8)),
  ),
  panels: Schema.optional(Schema.Array(PluginPanelContribution).check(Schema.isMaxLength(16))),
  /** One stylesheet applied to the app while the plugin is enabled. */
  themeCss: Schema.optional(PluginAssetPath),
});
export type PluginContributes = typeof PluginContributes.Type;

export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  /** Allowlist of contribution points this plugin may use; contributions beyond it are refused. */
  capabilities: Schema.Array(PluginCapability).check(Schema.isMaxLength(8)),
  contributes: Schema.optional(PluginContributes),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginRecord = Schema.Struct({
  manifest: PluginManifest,
  enabled: Schema.Boolean,
  /** Absolute path the plugin was installed from, when known. */
  source: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  installedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PluginRecord = typeof PluginRecord.Type;

export const PluginJournalOperation = Schema.Literals([
  "install",
  "enable",
  "disable",
  "remove",
  "revert",
]);
export type PluginJournalOperation = typeof PluginJournalOperation.Type;

export const PluginJournalEntry = Schema.Struct({
  at: IsoDateTime,
  operation: PluginJournalOperation,
  pluginId: PluginId,
  /** Human-readable summary of the store state before the operation. */
  detail: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type PluginJournalEntry = typeof PluginJournalEntry.Type;

export const PluginListResult = Schema.Struct({
  pluginsDir: Schema.String,
  plugins: Schema.Array(PluginRecord),
  journal: Schema.Array(PluginJournalEntry),
});
export type PluginListResult = typeof PluginListResult.Type;

export const PluginInstallRequest = Schema.Struct({
  /** Absolute path to a plugin directory on the server host, containing `plugin.json`. */
  sourcePath: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  /** Enable right after install; defaults to true. */
  enable: Schema.optional(Schema.Boolean),
});
export type PluginInstallRequest = typeof PluginInstallRequest.Type;

export const PluginOperationResult = Schema.Struct({
  ok: Schema.Literal(true),
  plugin: Schema.optionalKey(PluginRecord),
  /** Operation that was undone, for `revert`. */
  reverted: Schema.optionalKey(PluginJournalOperation),
});
export type PluginOperationResult = typeof PluginOperationResult.Type;
