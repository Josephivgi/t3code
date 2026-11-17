import {
  OrchestratorMcpFailure,
  PluginFilePath,
  PluginFileResult,
  PluginId,
  PluginListResult,
  PluginSummary,
} from "@t3tools/contracts";

import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as PluginStore from "../../../plugins/PluginStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const PluginWriteFile = Schema.Struct({
  path: PluginFilePath,
  content: Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024)),
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PluginStore.PluginStore,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};

const PluginListTool = Tool.make("t3_plugin_list", {
  ...shared,
  description:
    "List plugins on this server: whether each is on, what files it has, and the failure that turned it off, if any. Pass `id` to list one.",
  parameters: Schema.Struct({
    id: Schema.optionalKey(PluginId),
  }),
  success: PluginListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PluginReadTool = Tool.make("t3_plugin_read", {
  ...shared,
  description:
    "Read a plugin's file list, or one file with `path`. Also returns the guide to writing plugins, which covers JavaScript, Rust and SQLite plugins. Call it before `t3_plugin_write`.",
  parameters: Schema.Struct({
    id: PluginId,
    path: Schema.optionalKey(PluginFilePath),
  }),
  success: Schema.Struct({
    plugin: PluginSummary,
    files: Schema.Array(Schema.String),
    file: Schema.optionalKey(PluginFileResult),
    guide: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PluginWriteTool = Tool.make("t3_plugin_write", {
  ...shared,
  description: `Create a plugin, or change files of one. Text files only, at any path inside the plugin folder (plugin.json, client.js, style.css, server.js, and anything else such as Rust source under native/). Omitted files are kept. Writing a code or style file turns the plugin on and clears its failure; a write that changes only plugin.json keeps its current state. Open clients apply the change within a few seconds. Reports \`restartRequired\` when server.js changed; the server imports it again within a few seconds, so no restart is needed. Read the guide with \`t3_plugin_read\` first.`,
  parameters: Schema.Struct({
    id: PluginId,
    files: Schema.Array(PluginWriteFile).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  }),
  success: Schema.Struct({
    plugin: PluginSummary,
    restartRequired: Schema.Boolean,
  }),
}).annotate(Tool.Destructive, true);

const PluginSetEnabledTool = Tool.make("t3_plugin_set_enabled", {
  ...shared,
  description: "Turn a plugin on or off. Turning it on clears its recorded failure.",
  parameters: Schema.Struct({
    id: PluginId,
    enabled: Schema.Boolean,
  }),
  success: PluginSummary,
}).annotate(Tool.Destructive, true);

const PluginDeleteTool = Tool.make("t3_plugin_delete", {
  ...shared,
  description: "Delete a plugin and its files.",
  parameters: Schema.Struct({
    id: PluginId,
  }),
  success: Schema.Struct({ deleted: Schema.Literal(true) }),
}).annotate(Tool.Destructive, true);

export const PluginsToolkit = Toolkit.make(
  PluginListTool,
  PluginReadTool,
  PluginWriteTool,
  PluginSetEnabledTool,
  PluginDeleteTool,
);
