import type { ReactNode } from "react";
import { cn } from "cn";
import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder bars use the border colour: the stock bg-muted is nearly invisible on the page background. */
const BAR = "bg-border";

/** Widths cycled over the lines of a text block so the placeholder looks like ragged text. */
const LINE_WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-10/12", "w-2/3"] as const;

/**
 * Wrapper of every skeleton block. With a `label` it is a polite status region ("Loading runs") that
 * screen readers announce; without one the whole block is hidden from assistive technology.
 */
function SkeletonFrame({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  if (label) {
    // The grey bars have no text, so assistive technology reads only the label.
    return (
      <div role="status" aria-live="polite" className={className}>
        <span className="sr-only">{label}</span>
        {children}
      </div>
    );
  }
  return (
    <div aria-hidden="true" className={className}>
      {children}
    </div>
  );
}

export interface TextSkeletonProps {
  /** Number of grey lines. Default 3. */
  lines?: number;
  /** Screen-reader announcement, e.g. "Loading summary". Omit to hide the block from assistive technology. */
  label?: string;
  className?: string;
}

/** Grey bars standing in for a few lines of text. */
export function TextSkeleton({ lines = 3, label, className }: TextSkeletonProps) {
  return (
    <SkeletonFrame label={label} className={cn("space-y-2", className)}>
      {Array.from({ length: Math.max(1, lines) }, (_, i) => (
        <Skeleton key={i} className={cn(BAR, "h-4", LINE_WIDTHS[i % LINE_WIDTHS.length])} />
      ))}
    </SkeletonFrame>
  );
}

export interface CardSkeletonProps {
  /** Lines of text under the title bar. Default 3. */
  lines?: number;
  label?: string;
  className?: string;
}

/** A card-shaped placeholder: a title bar and a few lines of text. */
export function CardSkeleton({ lines = 3, label, className }: CardSkeletonProps) {
  return (
    <SkeletonFrame label={label} className={cn("space-y-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10", className)}>
      <Skeleton className={cn(BAR, "h-5 w-1/3")} />
      <TextSkeleton lines={lines} />
    </SkeletonFrame>
  );
}

export interface TableSkeletonProps {
  /** Body rows. Default 5. */
  rows?: number;
  /** Columns. Default 5. */
  columns?: number;
  label?: string;
  className?: string;
}

/** A table-shaped placeholder (a header bar and rows of cells) inside a card, for the first load of a list. */
export function TableSkeleton({ rows = 5, columns = 5, label, className }: TableSkeletonProps) {
  const cols = Math.max(1, columns);
  return (
    <SkeletonFrame label={label} className={cn("overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10", className)}>
      <div className="flex gap-4 border-b bg-muted/50 px-4 py-3">
        {Array.from({ length: cols }, (_, c) => (
          <Skeleton key={c} className={cn(BAR, "h-4 flex-1")} />
        ))}
      </div>
      {Array.from({ length: Math.max(1, rows) }, (_, r) => (
        <div key={r} className="flex items-center gap-4 border-b px-4 py-4 last:border-b-0">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn(BAR, "h-4 flex-1", c === 0 && "max-w-24")} />
          ))}
        </div>
      ))}
    </SkeletonFrame>
  );
}

export interface ListSkeletonProps {
  /** Rows. Default 6. */
  rows?: number;
  label?: string;
  className?: string;
}

/** A list of rows, each a round icon and two lines of text (the stepper, a list of sample cards). */
export function ListSkeleton({ rows = 6, label, className }: ListSkeletonProps) {
  return (
    <SkeletonFrame label={label} className={cn("space-y-4", className)}>
      {Array.from({ length: Math.max(1, rows) }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className={cn(BAR, "size-6 shrink-0 rounded-full")} />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={cn(BAR, "h-4 w-1/3")} />
            <Skeleton className={cn(BAR, "h-3 w-3/4")} />
          </div>
        </div>
      ))}
    </SkeletonFrame>
  );
}
