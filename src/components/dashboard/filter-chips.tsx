"use client";

import { ShieldAlert, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { DECISION_META } from "@/components/shared/decision-badge";
import { INK_TONE, type Tone } from "@/components/shared/tones";
import type { DashboardKpis } from "@/lib/types";
import { filterCount, type DashboardFilter } from "./run-format";

interface ChipDef {
  value: DashboardFilter;
  label: string;
  Icon: LucideIcon | null;
  /** Colour of the icon while the chip is not pressed (the icon and the label always travel together). */
  tone: Tone;
  /** The figure's name for the browser checks (the old KPI tile of the same name); "All" is named by the ledger bar. */
  kpi: string | null;
}

/** All, the three outcomes (as one segmented control) and Security, with the same icons and colours as the decision badges. */
const ALL_CHIP: ChipDef = { value: "all", label: "All", Icon: null, tone: "neutral", kpi: null };
const OUTCOME_CHIPS: readonly ChipDef[] = [
  { value: "APPROVE", label: "Approved", Icon: DECISION_META.APPROVE.Icon, tone: DECISION_META.APPROVE.tone, kpi: "Approved" },
  { value: "HOLD", label: "On hold", Icon: DECISION_META.HOLD.Icon, tone: DECISION_META.HOLD.tone, kpi: "On hold" },
  { value: "REJECT", label: "Rejected", Icon: DECISION_META.REJECT.Icon, tone: DECISION_META.REJECT.tone, kpi: "Rejected" },
];
const SECURITY_CHIP: ChipDef = { value: "security", label: "Security", Icon: ShieldAlert, tone: "security", kpi: "Security flags" };
export const FILTER_CHIPS: readonly ChipDef[] = [ALL_CHIP, ...OUTCOME_CHIPS, SECURITY_CHIP];

export interface FilterChipsProps {
  /** The pressed filter. */
  value: DashboardFilter;
  onChange: (filter: DashboardFilter) => void;
  /** Gives each chip its count. null (nothing loaded yet) shows the chips without counts. */
  kpis: DashboardKpis | null;
  className?: string;
}

const BASE =
  "inline-flex h-10 items-center justify-center gap-2 px-2.5 text-sm sm:px-3 font-medium whitespace-nowrap outline-none transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring sm:h-9";

/**
 * The filter row of the dashboard: real buttons in one labelled group; the pressed one has aria-pressed="true" and is
 * drawn filled (the others are outlines), so the state does not rest on colour. The three outcomes sit in one segmented
 * control. Each button shows an icon (not "All"), a text label and the number of runs it would show.
 */
export function FilterChips({ value, onChange, kpis, className }: FilterChipsProps) {
  function chip(def: ChipDef, shape: string) {
    const pressed = def.value === value;
    const count = kpis ? filterCount(def.value, kpis) : null;
    return (
      <button
        key={def.value}
        type="button"
        aria-pressed={pressed}
        data-filter={def.value}
        data-kpi={def.kpi ?? undefined}
        onClick={() => onChange(def.value)}
        className={cn(BASE, shape, pressed ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-accent")}
      >
        {/* below sm the three outcomes would not fit one row with icons: the word and the count stay */}
        {def.Icon ? <def.Icon aria-hidden="true" className={cn("hidden size-4 sm:block", !pressed && INK_TONE[def.tone])} /> : null}
        <span>{def.label}</span>
        {count !== null ? <span className="font-semibold tabular-nums">{count}</span> : null}
      </button>
    );
  }
  return (
    <div role="group" aria-label="Filter runs by outcome" className={cn("flex flex-wrap items-center gap-2", className)}>
      {chip(ALL_CHIP, "rounded-md border")}
      <div className="flex w-full min-w-0 sm:w-auto">
        {OUTCOME_CHIPS.map((def, i) => chip(def, cn("min-w-0 flex-1 border sm:flex-none", i === 0 ? "rounded-l-md" : "-ml-px", i === OUTCOME_CHIPS.length - 1 && "rounded-r-md")))}
      </div>
      {chip(SECURITY_CHIP, "rounded-md border")}
    </div>
  );
}
