import { FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { useUiStyle } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { SidebarInput, SidebarMenuButton } from "../ui/sidebar";
import { SidebarAzonNav } from "./SidebarChrome";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  hasProjects,
  projectScope,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const azonLayout = useUiStyle() === "azon";
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";

  const searchBox = (
    <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70">
      <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
      <SidebarInput
        ref={searchInputRef}
        nativeInput
        type="search"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
        onKeyDown={onSearchKeyDown}
        placeholder="Search"
        aria-label="Search threads"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={resultsVisible}
        aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
        aria-activedescendant={
          activeResultExists ? `sidebar-thread-search-result-${activeSearchResultIndex}` : undefined
        }
        className="min-w-0 flex-1"
      />
      {isSearching ? (
        <Button
          type="button"
          size="icon-micro"
          variant="ghost-muted"
          className="shrink-0"
          aria-label="Clear thread search"
          onClick={() => {
            onClearSearch();
            searchInputRef.current?.focus();
          }}
        >
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  );

  if (azonLayout) {
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

  return (
    <div className="flex items-center gap-1">
      {searchBox}
      <div className="flex shrink-0 items-center">
        {hasProjects ? (
          <>
            {projectScope}
            <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          </>
        ) : null}
        <SidebarHeaderIconButton
          label="New thread"
          tooltip={
            showNewThreadInProjectHint ? (
              <span className="flex flex-col gap-0.5">
                <span>{newThreadLabel}</span>
                <span className="text-muted-foreground">
                  New thread in current project: Shift+click
                  {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
                </span>
              </span>
            ) : (
              newThreadLabel
            )
          }
          disabled={newThreadDisabled}
          onClick={onNewThread}
        >
          <SquarePenIcon />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  azonLabel,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  /** Text shown beside the icon in the Azon layout. */
  azonLabel?: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  const azonLayout = useUiStyle() === "azon";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn(
              "relative shrink-0",
              azonLabel !== undefined && azonLayout ? "h-7 w-auto" : "size-7",
              className,
            )}
          />
        }
      >
        {children}
        {azonLabel !== undefined && azonLayout ? (
          <span className="text-xs">{azonLabel}</span>
        ) : null}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
