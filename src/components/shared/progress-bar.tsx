import { cn } from "cn";
import type { Tone } from "./tones";

/** Fill colour per tone, as SVG fill classes (complete literals so Tailwind finds them). */
const FILL: Record<Tone, string> = {
  approve: "fill-approve-solid",
  hold: "fill-hold-solid",
  reject: "fill-reject-solid",
  security: "fill-security-solid",
  info: "fill-primary",
  neutral: "fill-muted-foreground",
};

export interface ProgressBarProps {
  /** Amount so far (for a PO: the invoiced subtotal). Clamped to 0..max for the bar. */
  value: number;
  /** The whole (for a PO: its subtotal). A max of 0 or less draws an empty bar. */
  max: number;
  /** Accessible name, e.g. "PO-1003 invoiced". Required: a bar without a name tells a screen reader nothing. */
  label: string;
  /** Spoken value, e.g. "$24,000.00 of $30,000.00 invoiced". Default: the percentage. */
  valueText?: string;
  /** Fill colour. Default "info" (the accent). Use "reject" for a fully used or overdrawn PO. */
  tone?: Tone;
  className?: string;
}

/**
 * A thin progress bar with role="progressbar". The fill is an SVG rect sized by an attribute, not an inline
 * style, so it also renders under a strict Content-Security-Policy (no 'unsafe-inline' for styles).
 * Show the numbers as text next to it: the bar is a second view of them, not the only one. Server-safe.
 */
export function ProgressBar({ value, max, label, valueText, tone = "info", className }: ProgressBarProps) {
  const fraction = max > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, value / max)) : 0;
  const percent = Math.round(fraction * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText ?? `${percent}%`}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-secondary ring-1 ring-border ring-inset", className)}
    >
      <svg aria-hidden="true" focusable="false" className="block h-full w-full">
        <rect x="0" y="0" height="100%" width={`${fraction * 100}%`} className={FILL[tone]} />
      </svg>
    </div>
  );
}
