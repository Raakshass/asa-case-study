import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  Clock,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import type { Decision, RunStatus } from "@/lib/types";
import { SOFT_TONE, SOLID_TONE, type Tone } from "./tones";

/**
 * Label, tone and icon for each decision, so other components (KPI tiles, filter chips) match the badge.
 * `label` is the exact decision token; `outcome` is the same thing in the past tense for counts and filters.
 */
export const DECISION_META: Record<Decision, { label: Decision; outcome: string; tone: Tone; Icon: LucideIcon }> = {
  APPROVE: { label: "APPROVE", outcome: "Approved", tone: "approve", Icon: CircleCheck },
  HOLD: { label: "HOLD", outcome: "On hold", tone: "hold", Icon: CirclePause },
  REJECT: { label: "REJECT", outcome: "Rejected", tone: "reject", Icon: CircleX },
};

interface BadgeView {
  key: string;
  label: string;
  tone: Tone;
  Icon: LucideIcon;
  spin: boolean;
}

/** A run with no decision yet (or none at all): what to show depends on the run status when the caller passes it. */
function viewFor(decision: Decision | null, runStatus: RunStatus | undefined): BadgeView {
  if (decision) {
    const meta = DECISION_META[decision];
    return { key: decision, label: meta.label, tone: meta.tone, Icon: meta.Icon, spin: false };
  }
  switch (runStatus) {
    case "error":
      return { key: "error", label: "Error", tone: "reject", Icon: CircleAlert, spin: false };
    case "queued":
      return { key: "queued", label: "Queued", tone: "neutral", Icon: Clock, spin: false };
    case "done":
      return { key: "no-decision", label: "No decision", tone: "neutral", Icon: CircleDashed, spin: false };
    default:
      return { key: "in-progress", label: "In progress", tone: "info", Icon: LoaderCircle, spin: true };
  }
}

const SIZE = {
  sm: "h-5 gap-1 px-1.5 text-[11px] [&_svg]:size-3",
  md: "h-6 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5",
  lg: "h-10 gap-2 px-4 text-base [&_svg]:size-5",
} as const;

export interface DecisionBadgeProps {
  /** The run's decision. null renders "In progress" (a spinner icon), or Queued / Error when `runStatus` says so. */
  decision: Decision | null;
  /** Only used when `decision` is null: "queued" shows Queued, "error" shows Error, anything else In progress. */
  runStatus?: RunStatus;
  /** sm for table rows, md (default) inline, lg for the decision card. */
  size?: keyof typeof SIZE;
  /** soft: pale tint (default). solid: filled, for the big badge on the run page. */
  variant?: "soft" | "solid";
  className?: string;
}

/**
 * APPROVE (green check), HOLD (amber pause), REJECT (red cross), or a neutral in-progress state.
 * Always an icon AND a text label, never colour alone. Server-safe (no state, no effects).
 */
export function DecisionBadge({ decision, runStatus, size = "md", variant = "soft", className }: DecisionBadgeProps) {
  const view = viewFor(decision, runStatus);
  const { Icon } = view;
  return (
    <span
      data-decision={view.key}
      className={cn(
        "inline-flex w-fit shrink-0 items-center justify-center rounded-full border font-semibold tracking-wide whitespace-nowrap uppercase",
        SIZE[size],
        (variant === "solid" ? SOLID_TONE : SOFT_TONE)[view.tone],
        className,
      )}
    >
      <Icon aria-hidden="true" className={view.spin ? "animate-spin" : undefined} />
      <span>{view.label}</span>
    </span>
  );
}
