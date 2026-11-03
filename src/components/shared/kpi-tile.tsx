import type { ReactNode } from "react";
import { cn } from "cn";
import { Skeleton } from "@/components/ui/skeleton";
import { SOFT_TONE, type Tone } from "./tones";

export interface KpiTileProps {
  /** What is counted, e.g. "Approved". */
  label: string;
  /**
   * The figure: a number, or any node such as <Money value={...} />. It is 20px below 360 px, 24px on a phone
   * and 30px from the sm breakpoint. A money figure of six digits or more does not fit half a 375 px screen:
   * give that tile className="col-span-2 sm:col-span-1" in a two-column grid (as a last resort the figure
   * wraps inside its tile instead of spilling over the next one).
   */
  value: ReactNode;
  /** Small line under the figure, e.g. "of 14 invoices". */
  hint?: ReactNode;
  /** Optional icon element (for example <CircleCheck />); it is decorative and sits in a tinted square. */
  icon?: ReactNode;
  /** Tint of the icon square. Default "neutral". */
  tone?: Tone;
  /** Show a skeleton instead of the value (first load of a polled page). */
  loading?: boolean;
  className?: string;
}

/**
 * One KPI of the dashboard row: label, big tabular figure, optional hint and icon.
 * Server-safe (no state, no effects).
 */
export function KpiTile({ label, value, hint, icon, tone = "neutral", loading = false, className }: KpiTileProps) {
  return (
    <div
      data-kpi={label}
      aria-busy={loading || undefined}
      className={cn("flex min-w-0 flex-col gap-2 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10", className)}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium text-muted-foreground">{label}</p>
        {icon ? (
          <span
            aria-hidden="true"
            className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg border [&_svg]:size-4", SOFT_TONE[tone])}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 text-xl leading-tight font-semibold tracking-tight break-words tabular-nums min-[360px]:text-2xl sm:text-3xl sm:leading-none [&_*]:whitespace-normal">
        {loading ? <Skeleton aria-hidden="true" className="h-8 w-20 bg-border" /> : value}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
