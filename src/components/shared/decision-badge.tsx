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
import { INK_TONE, STAMP_TONE, type Tone } from "./tones";

/**
 * Label, tone and icon for each decision, so other components (KPI tiles, filter chips) match the badge.
 * `label` is the exact decision token (data-decision, API); `outcome` is the same thing in the past tense: it is
 * the word every badge, count and filter shows.
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
    return { key: decision, label: meta.outcome, tone: meta.tone, Icon: meta.Icon, spin: false };
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

/** Quiet badges: icon plus a sentence-case word in the decision's ink, no pill, no fill (the stamp is the loud one). */
const SIZE = {
  sm: "gap-1 text-sm [&_svg]:size-4",
  md: "gap-1.5 text-sm [&_svg]:size-4",
  lg: "gap-2 text-base [&_svg]:size-5",
} as const;

export interface DecisionBadgeProps {
  /** The run's decision. null renders "In progress" (a spinner icon), or Queued / Error when `runStatus` says so. */
  decision: Decision | null;
  /** Only used when `decision` is null: "queued" shows Queued, "error" shows Error, anything else In progress. */
  runStatus?: RunStatus;
  /** sm for table rows, md (default) inline, lg for the decision card. */
  size?: keyof typeof SIZE;
  /** soft: quiet icon and word (default). solid: the approval stamp, for the decision on the run page. */
  variant?: "soft" | "solid";
  className?: string;
}

/**
 * Approved (green check), On hold (amber pause), Rejected (red cross), or a neutral in-progress state.
 * Always an icon AND a text label, never colour alone. The stamp variant draws the same words in capitals
 * (CSS only; the text in the page stays sentence case). `data-decision` keeps the decision token.
 * Server-safe (no state, no effects).
 */
export function DecisionBadge({ decision, runStatus, size = "md", variant = "soft", className }: DecisionBadgeProps) {
  const view = viewFor(decision, runStatus);
  const { Icon } = view;
  const stamp = variant === "solid";
  return (
    <span
      data-decision={view.key}
      className={cn(
        "inline-flex w-fit shrink-0 items-center whitespace-nowrap",
        stamp ? ["stamp", STAMP_TONE[view.tone]] : ["font-semibold", SIZE[size], INK_TONE[view.tone]],
        className,
      )}
    >
      <Icon aria-hidden="true" className={view.spin ? "animate-spin" : undefined} />
      <span>{view.label}</span>
    </span>
  );
}
