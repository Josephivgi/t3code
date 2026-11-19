import type { EnvironmentId } from "@t3tools/contracts";
import { T } from "gt-react";
import { memo, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { pluginAssetUrl } from "../../lib/pluginsApi";
import { enabledPluginContributions, useEnvironmentPlugins } from "./useEnvironmentPlugins";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Applies `ui:theme-css` contributions: one stylesheet link per enabled plugin,
 * removed together when the plugin is disabled or removed.
 */
function PluginThemeCssLinks({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { api, plugins } = useEnvironmentPlugins(environmentId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps plugin theme stylesheet <link> nodes in document.head in step with enabled contributions while mounted
  useEffect(() => {
    if (api === null) return;
    const nodes = enabledPluginContributions(plugins).themeCss.map((entry) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = pluginAssetUrl(api, entry.pluginId, entry.href);
      link.dataset.pluginThemeCss = entry.pluginId;
      document.head.appendChild(link);
      return link;
    });
    return () => {
      for (const node of nodes) node.remove();
    };
  }, [api, plugins]);
  return null;
}

/**
 * Renders `ui:header-icon` contributions (e.g. the Devin icon plugin) as small
 * buttons in the chat header. Panel contributions open in a sandboxed iframe.
 */
export const PluginHeaderIcons = memo(function PluginHeaderIcons({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { api, plugins } = useEnvironmentPlugins(environmentId);
  const [openPanel, setOpenPanel] = useState<{ title: string; src: string } | null>(null);
  const contributions = enabledPluginContributions(plugins);
  if (
    api === null ||
    (contributions.headerIcons.length === 0 && contributions.panels.length === 0)
  ) {
    return <PluginThemeCssLinks environmentId={environmentId} />;
  }
  const iconButtons = [
    ...contributions.headerIcons.map((icon) => ({
      key: `${icon.pluginId}:${icon.icon}`,
      title: icon.title,
      src: pluginAssetUrl(api, icon.pluginId, icon.icon),
      href: icon.href ?? null,
    })),
    ...contributions.panels.map((panel) => ({
      key: `${panel.pluginId}:${panel.id}`,
      title: panel.title,
      src: null as string | null,
      href: null as string | null,
      panelSrc: pluginAssetUrl(api, panel.pluginId, panel.html),
    })),
  ];
  return (
    <>
      <PluginThemeCssLinks environmentId={environmentId} />
      {iconButtons.map((button) => (
        <Tooltip key={button.key}>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-plugin-icon={button.key}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  if ("panelSrc" in button && button.panelSrc) {
                    setOpenPanel({ title: button.title, src: button.panelSrc });
                  } else if (button.href) {
                    window.open(button.href, "_blank", "noopener,noreferrer");
                  }
                }}
              />
            }
          >
            {button.src ? (
              <img src={button.src} alt={button.title} className="size-4" />
            ) : (
              <span className="text-3xs font-semibold">{button.title.slice(0, 2)}</span>
            )}
          </TooltipTrigger>
          <TooltipPopup>{button.title}</TooltipPopup>
        </Tooltip>
      ))}
      {openPanel ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setOpenPanel(null)}
        >
          <div
            className={cn("h-[70vh] w-[80vw] rounded-lg bg-background shadow-xl")}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
              <span>{openPanel.title}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setOpenPanel(null)}
              >
                <T>Close</T>
              </button>
            </div>
            {/* Same-origin sandbox: plugin HTML gets scripts but no app cookies/DOM. */}
            <iframe
              title={openPanel.title}
              src={openPanel.src}
              sandbox="allow-scripts allow-forms allow-popups allow-downloads"
              className="h-[calc(70vh-41px)] w-full rounded-b-lg border-0"
            />
          </div>
        </div>
      ) : null}
    </>
  );
});
