import type { ReactNode } from "react";
import { cn } from "cn";

export interface TableFrameProps {
  /** Accessible name of the scrolling region, e.g. "Recent runs". Required: a focusable region needs a name. */
  label: string;
  /** TableHeader / TableBody / TableRow / TableHead / TableCell from components/ui/table (not its <Table>). */
  children: ReactNode;
  className?: string;
}

/**
 * Card-style frame around a wide table. The frame itself scrolls sideways when the table is wider than the
 * screen (375 px) and is keyboard-focusable with a name, so keyboard users can scroll it with the arrow keys
 * (WCAG 2.1.1; the stock shadcn <Table> wraps itself in a scroller that cannot take focus).
 *
 * Use it INSTEAD of the shadcn <Table> root and keep the shadcn parts inside:
 *   <TableFrame label="Recent runs"><TableHeader>...</TableHeader><TableBody>...</TableBody></TableFrame>
 * Server-safe (no state, no effects).
 */
export function TableFrame({ label, children, className }: TableFrameProps) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn("relative w-full overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10", className)}
    >
      <table data-slot="table" className="w-full caption-bottom text-sm">
        {children}
      </table>
    </div>
  );
}
