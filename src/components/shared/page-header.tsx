import type { ReactNode } from "react";
import { cn } from "cn";

export interface PageHeaderProps {
  /** The page's h1. Plain text or inline nodes. */
  title: ReactNode;
  /** One short sentence under the title. */
  description?: ReactNode;
  /** Buttons or links on the right (below the title on narrow screens). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Title row of a page: h1 with an optional description and an actions slot that wraps under the title at 375 px.
 * Pages must not render their own <main>: the layout already provides it. Server-safe.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight break-words text-balance">{title}</h1>
        {description ? (
          <p className="max-w-prose text-base text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
