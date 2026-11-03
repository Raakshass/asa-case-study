import type { ReactNode } from "react";
import { cn } from "cn";

export interface PageHeaderProps {
  /** The page's h1. Plain text or inline nodes. */
  title: ReactNode;
  /** One short sentence under the title. */
  description?: ReactNode;
  /** Small caption above the title, e.g. "Run" or a breadcrumb-like label. */
  eyebrow?: ReactNode;
  /** Buttons or links on the right (below the title on narrow screens). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Title row of a page: h1 with an optional description and an actions slot that wraps under the title at 375 px.
 * Pages must not render their own <main>: the layout already provides it. Server-safe.
 */
export function PageHeader({ title, description, eyebrow, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {eyebrow ? (
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{eyebrow}</p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight break-words text-balance sm:text-3xl">{title}</h1>
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground sm:text-base">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
