# Azon Beta: merged features

Inventory of the Azon threads, checked against this tree on 2026-11-16 (branch nightly-0.1.10).
Status: **merged** = in this tree and checked, **outside source** = lives outside this repo, **missing** = not found.

| # | Feature (thread) | Where | Status |
|---|---|---|---|
| 1 | Open Azon T3 Code fork | no code, it located this repo | n/a |
| 2 | Azon Desktop app: rebrand to "Azon Beta", own install folder | `apps/desktop/package.json` productName, `apps/desktop/scripts/electron-launcher.mjs`, rebrand across the tree | merged |
| 2b | Launcher that keeps Azon data apart from T3 Code (APPDATA, T3CODE_HOME) | `launch-azon-beta.cmd` in the install folder only | outside source (survives the copy-install) |
| 3 | "Azon" wordmark icon | `assets/prod/t3-black-*` (Windows ico, web favicons) | merged. macOS/iOS/Linux icons still T3 (need a Mac) |
| 4 | Plugin fixes: bearer auth, delete as POST, live apply (4 s), Settings > Plugins spacing, desktop CSP `blob:`, auto retry after an update | `apps/web/src/plugins/*`, `PluginsSettingsPanel.tsx`, `apps/desktop/src/electron/ElectronProtocol.ts`, `pluginRetry.logic.ts` | merged |
| 5 | Instant plugin reload (server.js re-imported on change) | `apps/server/src/plugins/PluginStore.ts` `watchServerPlugins`, wired in `apps/server/src/server.ts` | merged, conflict fixed (below) |
| 6 | App Launcher plugin | `C:\Users\Joe\azon-app-launcher-plugin` | outside source, merged with the cleanup change |
| 7 | Plugin platform: any file type, nested folders, 64 MB, `dir`/`dataDir`/`handle`, `api.call`, `registerSmallTool`, Settings > Small tools, Rust/SQLite guide | `PluginStore.ts`, `pluginGuide.ts`, `pluginHost.ts`, `smallTools.ts`, `SmallToolsSettingsPanel.tsx`, `packages/contracts/src/plugins.ts` | merged |
| 7b | JPerformance plugin (Rust napi addon) | `C:\Users\Joe\azon-plugin-dev\jperformance` | outside source |
| 8 | Conversation sync plugin (`t3-sync`) | only in the live plugins folder | missing from any source folder. Not copied: the live data folder is off limits for this merge |
| 9 | Droid and OpenCode Go limits on Usage (`extra-usage-limits`) | was only in a temp folder, now `C:\Users\Joe\azon-plugin-dev\extra-usage-limits` | outside source, merged with the cleanup change |

## Conflict resolved

Thread 5 (newest) made a changed `server.js` reload live, but older text from threads 4 and 7 still said it needed a server restart, and the old copy was never stopped. App Launcher's reload failed with `EADDRINUSE` while its old code kept the port.
Picked thread 5's behavior and finished it: `activate` may return a cleanup function, and the store runs it before importing the changed copy. App Launcher and the limits plugin now return one that closes their HTTP server. The "applies after the server restarts" text is gone from Settings > Plugins, the plugin guide and the `t3_plugin_write` description.
