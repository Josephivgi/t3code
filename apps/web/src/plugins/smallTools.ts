/** A self-contained utility a plugin adds under Settings > Small tools. */
export interface SmallTool {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Sidebar heading in Settings that lists the tool's page. Defaults to "Small tools". */
  readonly section?: string;
  /** Fills `container`, which the tool owns until the returned cleanup runs. */
  readonly mount: (container: HTMLElement) => void | (() => void) | Promise<void | (() => void)>;
}

export interface RegisteredSmallTool extends SmallTool {
  readonly pluginId: string;
  readonly key: string;
}

let tools: ReadonlyArray<RegisteredSmallTool> = [];
const listeners = new Set<() => void>();

const publish = (next: ReadonlyArray<RegisteredSmallTool>) => {
  tools = next;
  for (const listener of listeners) listener();
};

export const getSmallTools = () => tools;

export const subscribeSmallTools = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Adds a tool and returns the function that removes it. A plugin's tools go when it unloads. */
export function registerSmallTool(pluginId: string, tool: SmallTool): () => void {
  const key = `${pluginId}/${tool.id}`;
  const entry: RegisteredSmallTool = { ...tool, pluginId, key };
  publish([...tools.filter((existing) => existing.key !== key), entry]);
  return () => {
    if (tools.includes(entry)) publish(tools.filter((existing) => existing !== entry));
  };
}

export const smallToolSection = (tool: SmallTool) => tool.section?.trim() || "Small tools";
