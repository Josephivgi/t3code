import type { PluginId, PluginListResult, PluginSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pluginsToRetry } from "./pluginRetry.logic";

const plugin = (id: string, overrides: Partial<PluginSummary>): PluginSummary => ({
  id: id as PluginId,
  name: id,
  version: "1.0.0",
  supports: ["azon"],
  enabled: false,
  hasClient: true,
  hasStyle: false,
  hasServer: false,
  failureAcknowledged: false,
  ...overrides,
});

const failure = (phase: NonNullable<PluginSummary["failure"]>["phase"], build?: string) => ({
  at: "2026-11-16T00:00:00.000Z",
  phase,
  message: "broke",
  ...(build === undefined ? {} : { build }),
});

describe("pluginsToRetry", () => {
  it("retries page failures from another build or no build, once, and nothing else", () => {
    const list: PluginListResult = {
      revision: 1,
      plugins: [
        plugin("old-build", { failure: failure("client-activate", "build-1") }),
        plugin("no-build", { failure: failure("client-boot") }),
        plugin("this-build", { failure: failure("client-runtime", "build-2") }),
        plugin("server-failure", { failure: failure("server-activate", "build-1") }),
        plugin("unreadable", { failure: failure("manifest") }),
        plugin("turned-off-by-hand", {}),
        plugin("on-with-old-failure", { enabled: true, failure: failure("client-boot") }),
        plugin("retried-already", { failure: failure("client-activate", "build-1") }),
      ],
    };
    expect(pluginsToRetry(list, "build-2", new Set(["retried-already"]))).toEqual([
      "old-build",
      "no-build",
    ]);
  });
});
