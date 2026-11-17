import { useEffect } from "react";

import { startPluginHost } from "./pluginHost";

/** Starts client plugins once the person is signed in to this page's environment. */
export function PluginHostCoordinator({ authenticated }: { readonly authenticated: boolean }) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the plugin host, which talks to the server and the page outside React
  useEffect(() => {
    if (authenticated) void startPluginHost();
  }, [authenticated]);
  return null;
}
