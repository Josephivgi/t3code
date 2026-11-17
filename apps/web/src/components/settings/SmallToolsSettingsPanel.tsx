import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  getSmallTools,
  subscribeSmallTools,
  type RegisteredSmallTool,
} from "../../plugins/smallTools";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** Gives a tool an empty element to own, and runs the tool's cleanup when it closes or reloads. */
function SmallToolHost({ tool }: { tool: RegisteredSmallTool }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the tool draws into this element, outside React
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    let cleanup: void | (() => void);
    Promise.resolve()
      .then(() => tool.mount(container))
      .then((result) => {
        if (cancelled) result?.();
        else cleanup = result;
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      try {
        cleanup?.();
      } catch (cause) {
        console.warn(`[small tool ${tool.key}] cleanup threw`, cause);
      }
      container.replaceChildren();
    };
  }, [tool]);

  return (
    <>
      {error !== null ? (
        <p className="px-4 py-3 text-sm text-destructive">
          {tool.title} could not start: {error}
        </p>
      ) : null}
      <div
        ref={containerRef}
        className="relative isolate h-[calc(100vh-14rem)] min-h-96 overflow-auto [contain:layout_paint]"
      />
    </>
  );
}

/** One plugin tool's own Settings page. The tool draws inside a clipped, isolated box. */
export function SmallToolPage({ toolKey }: { toolKey: string }) {
  const tools = useSyncExternalStore(subscribeSmallTools, getSmallTools);
  const tool = tools.find((candidate) => candidate.key === toolKey);

  return (
    <SettingsPageContainer>
      {tool === undefined ? (
        <SettingsSection id="small-tool-missing" title="Tool not available">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            This tool is not loaded. Turn its plugin on in Settings &gt; Plugins.
          </p>
        </SettingsSection>
      ) : (
        <SettingsSection id="small-tool-open" title={tool.title}>
          {tool.description !== undefined ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{tool.description}</p>
          ) : null}
          <SmallToolHost key={tool.key} tool={tool} />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
