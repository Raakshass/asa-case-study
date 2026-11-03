import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { cn } from "cn";

export interface EmptyStateProps {
  /** Heading line, e.g. "No invoices yet". */
  title: string;
  /** One sentence of help under the title. */
  description?: ReactNode;
  /** Optional call to action (a Button or Link), e.g. "Try a sample". */
  action?: ReactNode;
  /** Icon element shown in a grey circle. Omit for the default inbox icon; pass null for no icon. */
  icon?: ReactNode;
  className?: string;
}

/** A dashed box that says there is nothing here yet and what to do next. Server-safe (no state, no effects). */
export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  const glyph = icon === undefined ? <Inbox /> : icon;
  return (
    <div
      data-empty-state="true"
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed border-input bg-card px-6 py-12 text-center",
        className,
      )}
    >
      {glyph ? (
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6"
        >
          {glyph}
        </span>
      ) : null}
      <div className="space-y-1">
        <p className="text-base font-medium">{title}</p>
        {description ? <p className="mx-auto max-w-md text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
