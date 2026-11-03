import { Check, Minus, X } from "lucide-react";
import { cn } from "cn";
import type { FieldGrounding } from "@/lib/types";

const VIEW = {
  grounded: {
    label: "Grounded: the value appears in the document text",
    short: "Grounded",
    Icon: Check,
    className: "text-approve",
  },
  missing: {
    label: "Not grounded: the value was not found in the document text",
    short: "Not grounded",
    Icon: X,
    className: "text-reject",
  },
  unchecked: {
    label: "Not checked: nothing to compare against",
    short: "Not checked",
    Icon: Minus,
    className: "text-muted-foreground",
  },
} as const;

export interface GroundedMarkProps {
  /**
   * FieldGrounding["status"] from the validate step's detail.grounding.fields, or null / undefined when the
   * step has no grounding (scanned PDF, or the step was skipped): shown as a dash.
   */
  status: FieldGrounding["status"] | null | undefined;
  /** Show the short text next to the mark. Default false: a tick, cross or dash with a screen-reader label. */
  showLabel?: boolean;
  className?: string;
}

/**
 * The grounded column of the extracted-fields table: a tick (found in the document text), a cross (not found)
 * or a dash (not checked). The glyph differs per state and the text label is always there, visible or
 * screen-reader only. Server-safe (no state, no effects).
 */
export function GroundedMark({ status, showLabel = false, className }: GroundedMarkProps) {
  const key = status === "grounded" ? "grounded" : status === "missing" ? "missing" : "unchecked";
  const { label, short, Icon, className: tone } = VIEW[key];
  return (
    <span data-grounded={key} title={label} className={cn("inline-flex items-center gap-1 font-medium", tone, className)}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {showLabel ? <span className="text-xs">{short}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}
