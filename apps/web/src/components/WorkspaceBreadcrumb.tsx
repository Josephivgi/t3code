import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils";

interface WorkspaceBreadcrumbProps {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly className?: string;
  /** Marks the thread header trail so layout styles can find it without matching its label. */
  readonly threadTrail?: boolean;
}

export function WorkspaceBreadcrumb({
  ariaLabel,
  children,
  className,
  threadTrail,
}: WorkspaceBreadcrumbProps) {
  return (
    <nav
      aria-label={ariaLabel}
      data-thread-trail={threadTrail ? "" : undefined}
      className={cn("min-w-0", className)}
    >
      <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm sm:gap-3">
        {children}
      </ol>
    </nav>
  );
}

interface WorkspaceBreadcrumbItemProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly current?: boolean;
}

export function WorkspaceBreadcrumbText({ children, className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="workspace-breadcrumb-text"
      className={cn(
        "block min-w-0 truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1.5",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export function WorkspaceBreadcrumbItem({
  children,
  className,
  current = false,
}: WorkspaceBreadcrumbItemProps) {
  return (
    <li
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex min-w-0 items-center font-medium",
        current ? "text-foreground" : "shrink-0 text-muted-foreground",
        className,
      )}
    >
      {children}
    </li>
  );
}

export function WorkspaceBreadcrumbSeparator({
  className,
  children = "/",
}: {
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <li aria-hidden="true" className={cn("flex shrink-0 items-center text-icon-muted", className)}>
      {children}
    </li>
  );
}
