import {
  Circle,
  CircleCheck,
  CircleMinus,
  CircleX,
  LoaderCircle,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import type { StepStatus } from "@/lib/types";
import { INK_TONE, type Tone } from "./tones";

/** The text label of each step status (what a screen reader announces, or the visible label with `showLabel`). */
export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  pass: "Passed",
  warn: "Warning",
  fail: "Failed",
  skipped: "Skipped",
  error: "System error",
};

const VIEW: Record<StepStatus, { Icon: LucideIcon; tone: Tone; spin: boolean }> = {
  pending: { Icon: Circle, tone: "neutral", spin: false },
  running: { Icon: LoaderCircle, tone: "info", spin: true },
  pass: { Icon: CircleCheck, tone: "approve", spin: false },
  warn: { Icon: TriangleAlert, tone: "hold", spin: false },
  fail: { Icon: CircleX, tone: "reject", spin: false },
  skipped: { Icon: CircleMinus, tone: "neutral", spin: false },
  error: { Icon: OctagonAlert, tone: "reject", spin: false },
};

const SIZE = { sm: "size-4", md: "size-5", lg: "size-6" } as const;

export interface StepStatusIconProps {
  status: StepStatus;
  /** Icon size: sm 16px, md 20px (default), lg 24px. */
  size?: keyof typeof SIZE;
  /** Show the text label next to the icon. Default false: the label is then visually hidden but still read aloud. */
  showLabel?: boolean;
  className?: string;
}

/**
 * Status icon of one pipeline stage: pending (hollow circle), running (spinner), pass (green check),
 * warn (amber triangle), fail (red cross), skipped (minus) and error (octagon). The shape differs per status
 * and a text label is always present (visible or screen-reader only), so colour is never the only signal.
 * Server-safe (no state, no effects).
 */
export function StepStatusIcon({ status, size = "md", showLabel = false, className }: StepStatusIconProps) {
  const { Icon, tone, spin } = VIEW[status];
  return (
    <span data-status={status} className={cn("inline-flex shrink-0 items-center gap-1.5", INK_TONE[tone], className)}>
      <Icon aria-hidden="true" className={cn(SIZE[size], spin && "animate-spin")} />
      {showLabel ? (
        <span className="text-xs font-medium">{STEP_STATUS_LABEL[status]}</span>
      ) : (
        <span className="sr-only">{STEP_STATUS_LABEL[status]}</span>
      )}
    </span>
  );
}
