"use client";

import { Layers, ShieldAlert, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { DECISION_META } from "@/components/shared/decision-badge";
import { INK_TONE, type Tone } from "@/components/shared/tones";
import { Button } from "@/components/ui/button";
import type { DashboardKpis } from "@/lib/types";
import { filterCount, type DashboardFilter } from "./run-format";

interface ChipDef {
  value: DashboardFilter;
  label: string;
  Icon: LucideIcon;
  /** Colour of the icon while the chip is not pressed (the icon and the label always travel together). */
  tone: Tone;
}

/** All / Approved / Hold / Rejected / Security, with the same icons and colours as the decision badges. */
export const FILTER_CHIPS: readonly ChipDef[] = [
  { value: "all", label: "All", Icon: Layers, tone: "neutral" },
  { value: "APPROVE", label: "Approved", Icon: DECISION_META.APPROVE.Icon, tone: DECISION_META.APPROVE.tone },
  { value: "HOLD", label: "Hold", Icon: DECISION_META.HOLD.Icon, tone: DECISION_META.HOLD.tone },
  { value: "REJECT", label: "Rejected", Icon: DECISION_META.REJECT.Icon, tone: DECISION_META.REJECT.tone },
  { value: "security", label: "Security", Icon: ShieldAlert, tone: "security" },
];

export interface FilterChipsProps {
  /** The pressed filter. */
  value: DashboardFilter;
  onChange: (filter: DashboardFilter) => void;
  /** Gives each chip its count. null (nothing loaded yet) shows the chips without counts. */
  kpis: DashboardKpis | null;
  className?: string;
}

/**
 * The filter row of the dashboard: real buttons in one labelled group, the pressed one has aria-pressed="true"
 * and is drawn filled (the others are outlines), so the state does not rest on colour. Each chip shows an icon,
 * a text label and the number of runs it would show.
 */
export function FilterChips({ value, onChange, kpis, className }: FilterChipsProps) {
  return (
    <div role="group" aria-label="Filter runs by outcome" className={cn("flex flex-wrap gap-2", className)}>
      {FILTER_CHIPS.map(({ value: chip, label, Icon, tone }) => {
        const pressed = chip === value;
        const count = kpis ? filterCount(chip, kpis) : null;
        return (
          <Button
            key={chip}
            type="button"
            size="lg"
            variant={pressed ? "default" : "outline"}
            aria-pressed={pressed}
            data-filter={chip}
            onClick={() => onChange(chip)}
            className="h-10 gap-2 px-3 text-sm sm:h-9"
          >
            <Icon aria-hidden="true" className={cn("size-4", !pressed && INK_TONE[tone])} />
            <span>{label}</span>
            {count !== null ? (
              <span
                className={cn(
                  "min-w-6 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums",
                  pressed ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {count}
              </span>
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}
