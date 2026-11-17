import { FolderPlusIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Button } from "../ui/button";
import { SidebarAzonNav } from "./SidebarChrome";

/** Azon layout: the top of the sidebar as labeled actions, a search box and the main places. */
export function AzonSidebarHeader({
  hasProjects,
  projectScope,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadLabel,
  newThreadShortcutLabel,
  searchBox,
}: {
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadLabel: string;
  newThreadShortcutLabel: string | null | undefined;
  searchBox: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="default"
        size="sm"
        className="w-full justify-start"
        disabled={newThreadDisabled}
        aria-label={newThreadLabel}
        onClick={onNewThread}
      >
        <SquarePenIcon className="size-4" />
        <span className="truncate">New thread</span>
        {newThreadShortcutLabel ? (
          <span className="ms-auto shrink-0 text-xs font-normal opacity-80">
            {newThreadShortcutLabel}
          </span>
        ) : null}
      </Button>
      {searchBox}
      <SidebarAzonNav />
      {hasProjects ? (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start"
            onClick={onNewProject}
          >
            <FolderPlusIcon className="size-4" />
            <span className="truncate">Add project</span>
          </Button>
          {projectScope}
        </div>
      ) : null}
    </div>
  );
}
