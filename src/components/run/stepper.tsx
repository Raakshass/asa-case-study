"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { DECISION_META, DecisionBadge } from "@/components/shared/decision-badge";
import { STEP_STATUS_LABEL, StepStatusIcon } from "@/components/shared/step-status-icon";
import { INK_TONE, SOFT_TONE } from "@/components/shared/tones";
import { Button } from "@/components/ui/button";
import { DECISIONS, STAGES, type Decision, type RunDetail, type StageKey, type StepView } from "@/lib/types";
import { EvidenceBoundary, EvidencePanel } from "./evidence-panels";
import { STATUS_TONE, displayText, formatDuration, stepDurationMs, stepImpact } from "./run-format";

/** The row of a stage the pipeline has not written yet (a queued run, or one whose rows are still being created). */
function pendingStep(stage: (typeof STAGES)[number]): StepView {
  return { idx: stage.idx, key: stage.key, label: stage.label, status: "pending", severity: null, reason: null, detail: null, started_at: null, finished_at: null };
}

/** The decision a finished decide stage reached: from its own detail, else the run's. */
function decisionOf(step: StepView, run: RunDetail): Decision | null {
  const own = step.detail?.decision;
  if (typeof own === "string" && (DECISIONS as readonly string[]).includes(own)) return own as Decision;
  return run.decision;
}

interface StepRowProps {
  step: StepView;
  run: RunDetail;
  first: boolean;
  last: boolean;
  open: boolean;
  onToggle: (key: StageKey) => void;
  panelId: string;
  buttonId: string;
}

/**
 * One stage: a real button (aria-expanded) with the status icon and its word, the stage name, what it means for the
 * decision, how long it took and the reason; open, it shows the evidence below. The status icon always comes with
 * text: the icon's own screen-reader label, plus the same word drawn for sighted readers.
 */
function StepRow({ step, run, first, last, open, onToggle, panelId, buttonId }: StepRowProps) {
  const tone = STATUS_TONE[step.status];
  const expandable = step.status !== "pending";
  // A run that stopped with an error never reached a decision, so none of its stages puts anything on hold.
  const impact = run.status === "error" ? null : stepImpact(step);
  const duration = step.status === "running" || step.status === "pending" ? null : formatDuration(stepDurationMs(step));
  const reason = displayText(step.reason, 1500);
  const showsDecision = step.key === "decide" && step.status === "pass";
  const decision = showsDecision ? decisionOf(step, run) : null;
  const DecisionIcon = decision ? DECISION_META[decision].Icon : null;
  const nodeTone = decision ? DECISION_META[decision].tone : tone;
  // The button is named by what it shows (WCAG 2.5.3: the visible words are in the name). The panel it opens is named by the title.
  const titleId = `${buttonId}-title`;

  return (
    <li data-stage={step.key} data-status={step.status} className="relative">
      <button
        type="button"
        id={buttonId}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable && open ? panelId : undefined}
        disabled={!expandable}
        onClick={() => onToggle(step.key)}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-4",
          expandable ? "cursor-pointer hover:bg-accent/40" : "cursor-default",
          step.status === "running" && "bg-accent/30",
        )}
      >
        <span
          className={cn(
            "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors duration-300 motion-reduce:transition-none",
            SOFT_TONE[nodeTone],
          )}
        >
          {DecisionIcon ? <DecisionIcon aria-hidden="true" className="size-5" /> : <StepStatusIcon status={step.status} size="md" />}
        </span>
        <span className="min-w-0 flex-1 pt-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span id={titleId} className="inline-flex items-center gap-x-2">
              <span className="text-xs text-muted-foreground tabular-nums">{step.idx}</span>
              <span className="text-sm font-semibold">{step.label}</span>
              {decision ? <DecisionBadge decision={decision} size="sm" /> : null}
            </span>
            {decision ? null : (
              <span aria-hidden="true" className={cn("text-xs font-medium", INK_TONE[tone])}>
                {STEP_STATUS_LABEL[step.status]}
              </span>
            )}
            {impact ? (
              <span
                className={cn(
                  "inline-flex h-5 items-center rounded-full border px-1.5 text-[11px] font-semibold tracking-wide uppercase",
                  SOFT_TONE[impact.tone],
                )}
              >
                <span className="sr-only">Effect on the decision: </span>
                {impact.label}
              </span>
            ) : null}
          </span>
          {reason ? (
            <span className={cn("mt-1 block text-sm break-words text-muted-foreground [overflow-wrap:anywhere]", !open && "line-clamp-2")}>
              {reason}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pt-1 text-xs text-muted-foreground tabular-nums">
          {duration ? <span>{duration}</span> : null}
          {expandable ? <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-180")} /> : null}
        </span>
      </button>
      {expandable && open ? (
        <div id={panelId} role="region" aria-labelledby={titleId} className="relative z-10 px-3 pb-4 sm:pr-4 sm:pl-16">
          {/* On a phone the panel takes the full width (evidence tables need it) and covers the rail; from sm up it sits right of the rail. */}
          <div className="rounded-lg bg-background p-3 sm:p-4">
            <EvidenceBoundary key={`${step.status}|${step.finished_at ?? ""}`}>
              <EvidencePanel step={step} promptVersion={run.prompt_version} />
            </EvidenceBoundary>
          </div>
        </div>
      ) : null}
      {/* The rail that joins the stage nodes: starts at the first node's centre and ends at the last one's. */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-[1.8rem] w-px bg-border sm:left-[2.05rem]",
          first ? "top-7 bottom-0" : last ? "top-0 h-7" : "inset-y-0",
        )}
      />
    </li>
  );
}

export interface StepperProps {
  run: RunDetail;
}

/**
 * The ten stages as a vertical stepper. Every row is a button; the rows a visitor opened stay open while the run
 * is polled (the state lives here, not in the data), and "Expand all" opens every stage that has started.
 */
export function Stepper({ run }: StepperProps) {
  const uid = useId();
  const [open, setOpen] = useState<ReadonlySet<StageKey>>(() => new Set());
  const byKey = new Map(run.steps.map((s) => [s.key, s]));
  const rows = STAGES.map((stage) => byKey.get(stage.key) ?? pendingStep(stage));
  const expandable = rows.filter((s) => s.status !== "pending");
  const allOpen = expandable.length > 0 && expandable.every((s) => open.has(s.key));

  function toggle(key: StageKey) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setOpen(allOpen ? new Set() : new Set(expandable.map((s) => s.key)));
  }

  return (
    <section aria-labelledby={`${uid}-heading`} className="rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3 sm:px-5">
        <div className="min-w-0 space-y-1">
          <h2 id={`${uid}-heading`} className="text-base font-semibold">
            Pipeline
          </h2>
          <p className="text-sm text-muted-foreground">Ten stages, one after the other. Select a stage to see the evidence behind it.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={toggleAll} disabled={expandable.length === 0}>
          {allOpen ? "Collapse all" : "Expand all"}
        </Button>
      </div>
      <ol className="divide-y divide-border border-t border-border">
        {rows.map((step, i) => (
          <StepRow
            key={step.key}
            step={step}
            run={run}
            first={i === 0}
            last={i === rows.length - 1}
            open={open.has(step.key)}
            onToggle={toggle}
            panelId={`${uid}-${step.key}-panel`}
            buttonId={`${uid}-${step.key}-button`}
          />
        ))}
      </ol>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-5">
        Stage times include a short pause between stages that keeps the live view easy to follow.
      </p>
    </section>
  );
}
