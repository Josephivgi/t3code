import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Azon layout for the inside of a thread row: the title leads, the status sits at its end, and the
 * project and meta line sit beneath. It only arranges the pieces the row already built, so drag,
 * keyboard, menus and the hover controls keep working as in the T3 Code layout.
 */
export function AzonThreadRowFace(props: {
  readonly leading: ReactNode;
  readonly title: ReactNode;
  readonly titleLineIcons: ReactNode;
  readonly statusSlot: ReactNode;
  readonly sweepSlot: ReactNode;
  readonly projectFavicon: ReactNode;
  readonly projectName: string | null | undefined;
  readonly metaLine: ReactNode;
  readonly metaLineEmpty: boolean;
}) {
  return (
    <div
      data-azon-thread-row
      className={cn(
        "relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
        props.metaLineEmpty && "h-auto",
      )}
    >
      <div className="flex min-h-5 min-w-0 items-center gap-1.5">
        {props.leading}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
          {props.title}
          {props.titleLineIcons}
        </div>
        {props.statusSlot}
        {props.sweepSlot}
      </div>
      <div className="mt-1 flex min-h-4 min-w-0 items-center gap-1.5 text-xs text-secondary-label">
        {props.projectFavicon}
        {props.projectName ? <span className="min-w-0 truncate">{props.projectName}</span> : null}
      </div>
      {props.metaLine}
    </div>
  );
}
