import {
  OrchestratorMcpFailure,
  PluginId,
  PluginJournalEntry,
  PluginOperationResult,
  PluginRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PluginManager from "../../../plugins/PluginManager.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    PluginManager.PluginManagerService,
    ThreadManagementService.ThreadManagementService,
  ],
};

const PluginsListTool = Tool.make("t3_plugins_list", {
  ...shared,
  description:
    "List T3 Code plugins installed on this environment: id, enabled state, manifest, and the recent operation journal. Call before `t3_plugins_install`, `t3_plugins_set_enabled`, `t3_plugins_remove`, or `t3_plugins_revert`.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({
    pluginsDir: Schema.String,
    plugins: Schema.Array(PluginRecord),
    journal: Schema.Array(PluginJournalEntry),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PluginsInstallTool = Tool.make("t3_plugins_install", {
  ...shared,
  description:
    "Install or update a T3 Code plugin from a directory on this machine containing a `plugin.json` manifest. The manifest's capabilities must cover every contribution the plugin ships; unsafe plugins are refused without changing the store. Installs are recorded and can be undone with `t3_plugins_revert`.",
  parameters: Schema.Struct({
    sourcePath: Schema.String.annotate({
      description: "Absolute path to the plugin directory on this machine.",
    }),
    enable: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Enable right after install (default true)." }),
    ),
  }),
  success: PluginOperationResult,
}).annotate(Tool.Destructive, true);

const PluginsSetEnabledTool = Tool.make("t3_plugins_set_enabled", {
  ...shared,
  description:
    "Enable or disable an installed T3 Code plugin without removing it. Disabled plugins keep their files and contribute nothing until re-enabled.",
  parameters: Schema.Struct({
    pluginId: PluginId,
    enabled: Schema.Boolean,
  }),
  success: PluginOperationResult,
}).annotate(Tool.Destructive, true);

const PluginsRemoveTool = Tool.make("t3_plugins_remove", {
  ...shared,
  description:
    "Remove an installed T3 Code plugin. Its files move to the plugins trash so `t3_plugins_revert` can restore it.",
  parameters: Schema.Struct({
    pluginId: PluginId,
  }),
  success: PluginOperationResult,
}).annotate(Tool.Destructive, true);

const PluginsRevertTool = Tool.make("t3_plugins_revert", {
  ...shared,
  description:
    "Undo the most recent revertable plugin operation (the latest install, enable, disable or remove that has not already been reverted) for `pluginId`, or across all plugins when omitted.",
  parameters: Schema.Struct({
    pluginId: Schema.optionalKey(PluginId),
  }),
  success: Schema.Struct({
    ok: Schema.Literal(true),
    reverted: Schema.String,
    plugin: Schema.optionalKey(PluginRecord),
  }),
}).annotate(Tool.Destructive, true);

export const PluginsToolkit = Toolkit.make(
  PluginsListTool,
  PluginsInstallTool,
  PluginsSetEnabledTool,
  PluginsRemoveTool,
  PluginsRevertTool,
);
