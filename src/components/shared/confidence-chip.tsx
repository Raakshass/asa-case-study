import { cn } from "cn";
import { CONFIDENCE_TONE, confidenceTone } from "@/lib/format";
import { SOFT_TONE, type Tone } from "./tones";

const VIEW: Record<"high" | "medium" | "low", { label: string; tone: Tone; bars: 1 | 2 | 3 }> = {
  high: { label: "High confidence", tone: "approve", bars: 3 },
  medium: { label: "Medium confidence", tone: "hold", bars: 2 },
  low: { label: "Low confidence", tone: "reject", bars: 1 },
};

const SIZE = {
  sm: { box: "h-5 text-[11px]", pad: "gap-1 px-1.5 [&_svg]:size-3" },
  md: { box: "h-6 text-xs", pad: "gap-1.5 px-2 [&_svg]:size-3.5" },
} as const;

const BASE =
  "inline-flex w-fit shrink-0 items-center justify-center rounded-full border font-medium tabular-nums whitespace-nowrap";

/**
 * Three bars of rising height; `filled` of them (1 low, 2 medium, 3 high) are solid and the rest faint.
 * Drawn by hand because the stock signal icons turn to mush at 12 to 14 px. Attributes only, no inline style.
 */
function LevelBars({ filled }: { filled: 1 | 2 | 3 }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 14 14" fill="currentColor" className="shrink-0">
      <rect x="1" y="8" width="3" height="5" rx="0.75" />
      <rect x="5.5" y="5" width="3" height="8" rx="0.75" opacity={filled >= 2 ? 1 : 0.25} />
      <rect x="10" y="2" width="3" height="11" rx="0.75" opacity={filled >= 3 ? 1 : 0.25} />
    </svg>
  );
}

export interface ConfidenceChipProps {
  /** The model's confidence, 0 to 1. null (or a non-number) shows a dash. */
  value: number | null | undefined;
  size?: keyof typeof SIZE;
  className?: string;
}

/**
 * Confidence of one extracted field: green at 0.90 or more, amber from 0.75 to 0.90, red below 0.75
 * (thresholds from confidenceTone() in src/lib/format.ts). Shows the number with two decimals plus a
 * three-bar level meter (three, two or one solid bar) and a screen-reader label, so colour is not the only cue.
 * Server-safe (no state, no effects).
 */
export function ConfidenceChip({ value, size = "md", className }: ConfidenceChipProps) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return (
      <span data-confidence="none" className={cn(BASE, SIZE[size].box, "px-2", SOFT_TONE.neutral, className)}>
        <span aria-hidden="true">–</span>
        <span className="sr-only">No confidence reported</span>
      </span>
    );
  }
  const level = confidenceTone(value);
  const { label, tone, bars } = VIEW[level];
  const threshold =
    level === "high"
      ? `${CONFIDENCE_TONE.high.toFixed(2)} or above`
      : level === "medium"
        ? `${CONFIDENCE_TONE.medium.toFixed(2)} to below ${CONFIDENCE_TONE.high.toFixed(2)}`
        : `below ${CONFIDENCE_TONE.medium.toFixed(2)}`;
  return (
    <span
      data-confidence={level}
      title={`${label} (${threshold})`}
      className={cn(BASE, SIZE[size].box, SIZE[size].pad, SOFT_TONE[tone], className)}
    >
      <LevelBars filled={bars} />
      <span>{value.toFixed(2)}</span>
      <span className="sr-only">, {label.toLowerCase()}</span>
    </span>
  );
}
