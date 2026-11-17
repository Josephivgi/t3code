import type { PluginListResult } from "@t3tools/contracts";

/**
 * Plugins the page turned off under another build. An update may have fixed what broke them, so
 * each gets one more try; failing again records this build, which stops further retries.
 */
export function pluginsToRetry(
  list: PluginListResult,
  build: string,
  alreadyRetried: ReadonlySet<string>,
): string[] {
  return list.plugins
    .filter(
      (plugin) =>
        !plugin.enabled &&
        plugin.failure !== undefined &&
        plugin.failure.phase.startsWith("client-") &&
        plugin.failure.build !== build &&
        !alreadyRetried.has(plugin.id),
    )
    .map((plugin) => plugin.id);
}
