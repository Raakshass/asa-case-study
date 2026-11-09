"use client";

import { useId, type JSX } from "react";
import { Circle, CircleCheck, CircleMinus, CircleX, LoaderCircle, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { DECISION_META } from "@/components/shared/decision-badge";
import { STEP_STATUS_LABEL } from "@/components/shared/step-status-icon";
import { INK_TONE, SOFT_TONE } from "@/components/shared/tones";
import { DECISIONS, STAGES, type Decision, type RunDetail, type StepStatus, type StepView } from "@/lib/types";
import { STATUS_TONE } from "./run-format";
import { STAGE_PLAIN } from "./stage-plain";

/**
 * The pipeline map of the run page: the ten checks drawn as node cards on a canvas, like a workflow editor, joined by
 * connectors with a port at each end. Each card shows its stage, the question it answers in plain words and its status
 * (a word and an icon, never colour alone); the stage being worked on glows and the line into it flows.
 *
 * It is a picture of the stepper below, which stays the accessible, interactive version: the node grid is aria-hidden
 * and nothing in it can be focused or clicked. The layout follows the map's own width (container queries, so it fits
 * wherever it is placed): one column with vertical connectors; two columns from 32rem; two rows of five from 64rem.
 * Both multi-column layouts are a snake (left to right, down, right to left). Reduced motion stops the glow and flow.
 */

const STATUS_ICON: Record<StepStatus, LucideIcon> = {
  pending: Circle,
  running: LoaderCircle,
  pass: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
  skipped: CircleMinus,
  error: OctagonAlert,
};

/* ------------------------------------------------------------------------------------------------ layout */

type Dir = "down" | "right" | "left";
const DIRS: readonly Dir[] = ["down", "right", "left"];
/** Columns of the three layouts: the base one, from @lg (32rem) and from @5xl (64rem). */
const LAYOUTS = [1, 2, 5] as const;

/** Where stage i sits in a snake of `cols` columns: even rows run left to right, odd rows right to left. */
function cell(i: number, cols: number): { row: number; col: number } {
  const row = Math.floor(i / cols);
  const p = i % cols;
  return { row, col: row % 2 === 0 ? p : cols - 1 - p };
}

/** Which way the connector out of stage i runs in a snake of `cols` columns; null after the last stage. */
function outDir(i: number, cols: number): Dir | null {
  if (i >= STAGES.length - 1) return null;
  if (i % cols === cols - 1) return "down";
  return Math.floor(i / cols) % 2 === 0 ? "right" : "left";
}

// Complete class names only, so Tailwind's source scan finds every one of them.
const COL2 = ["@lg:col-start-1", "@lg:col-start-2"];
const ROW2 = ["@lg:row-start-1", "@lg:row-start-2", "@lg:row-start-3", "@lg:row-start-4", "@lg:row-start-5"];
const COL5 = ["@5xl:col-start-1", "@5xl:col-start-2", "@5xl:col-start-3", "@5xl:col-start-4", "@5xl:col-start-5"];
const ROW5 = ["@5xl:row-start-1", "@5xl:row-start-2"];
const SHOW = [
  ["block", "hidden"],
  ["@lg:block", "@lg:hidden"],
  ["@5xl:block", "@5xl:hidden"],
] as const;

/** Per stage: its grid cell in each layout, and each connector it draws with the layouts it is shown in. */
const SLOTS = STAGES.map((_, i) => {
  const two = cell(i, 2);
  const five = cell(i, 5);
  return {
    place: [COL2[two.col], ROW2[two.row], COL5[five.col], ROW5[five.row]].join(" "),
    outs: DIRS.filter((dir) => LAYOUTS.some((cols) => outDir(i, cols) === dir)).map((dir) => ({
      dir,
      show: LAYOUTS.map((cols, n) => SHOW[n][outDir(i, cols) === dir ? 0 : 1]).join(" "),
    })),
  };
});

/* ------------------------------------------------------------------------------------------------ connectors */

/** flow: leads into the running stage; done: the stage before it has finished; idle: not reached yet. */
type Link = "flow" | "done" | "idle";

const LINK_INK: Record<Link, string> = { flow: "text-ring", done: "text-muted-foreground/70", idle: "text-input/70" };

/** The connector's box spans the grid gap (gap-8) next to its card. */
const BOX: Record<Dir, string> = {
  down: "top-full left-1/2 h-8 w-4 -translate-x-1/2",
  right: "left-full top-1/2 h-4 w-8 -translate-y-1/2",
  left: "right-full top-1/2 h-4 w-8 -translate-y-1/2",
};

/** Line ends, from the stage before to the stage after, so the dashes flow the right way. */
const ENDS: Record<Dir, { x1: string; y1: string; x2: string; y2: string }> = {
  down: { x1: "50%", y1: "0", x2: "50%", y2: "100%" },
  right: { x1: "0", y1: "50%", x2: "100%", y2: "50%" },
  left: { x1: "100%", y1: "50%", x2: "0", y2: "50%" },
};

function linkInto(prev: StepView, next: StepView, live: boolean): Link {
  if (next.status === "running") return "flow";
  const prevDone = prev.status !== "pending" && prev.status !== "running";
  // Once a run has stopped, a stage it never reached gets no solid line leading into it.
  return prevDone && (live || next.status !== "pending") ? "done" : "idle";
}

function Connector({ dir, link, show }: { dir: Dir; link: Link; show: string }) {
  const line = { ...ENDS[dir], stroke: "currentColor", strokeWidth: 2 };
  const ports = dir === "down" ? ["left-1/2 top-0", "left-1/2 top-full"] : ["left-0 top-1/2", "left-full top-1/2"];
  return (
    <span data-link={link} className={cn("pointer-events-none absolute z-10", BOX[dir], LINK_INK[link], show)}>
      <svg className="absolute inset-0 size-full overflow-visible">
        {link === "flow" ? (
          <>
            <g className="motion-reduce:hidden">
              <line {...line} strokeDasharray="6 4">
                <animate attributeName="stroke-dashoffset" from="10" to="0" dur="0.6s" repeatCount="indefinite" />
              </line>
            </g>
            <g className="hidden motion-reduce:inline">
              <line {...line} strokeDasharray="6 4" />
            </g>
          </>
        ) : (
          <line {...line} strokeDasharray={link === "idle" ? "2 4" : undefined} />
        )}
      </svg>
      {ports.map((at) => (
        <span
          key={at}
          className={cn(
            "absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
            at,
            link === "idle" ? "border-2 border-current bg-card" : "bg-current",
          )}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------ nodes */

/** The row of a stage the pipeline has not written yet (as in the stepper). */
function pendingStep(stage: (typeof STAGES)[number]): StepView {
  return { idx: stage.idx, key: stage.key, label: stage.label, status: "pending", severity: null, reason: null, detail: null, started_at: null, finished_at: null };
}

/** The decision a finished decide stage reached: from its own detail, else the run's (as in the stepper). */
function decisionOf(step: StepView, run: RunDetail): Decision | null {
  if (step.key !== "decide" || step.status !== "pass") return null;
  const own = step.detail?.decision;
  if (typeof own === "string" && (DECISIONS as readonly string[]).includes(own)) return own as Decision;
  return run.decision;
}

function NodeCard({ step, decision }: { step: StepView; decision: Decision | null }) {
  const { question, Icon } = STAGE_PLAIN[step.key];
  const running = step.status === "running";
  const pending = step.status === "pending";
  const tone = decision ? DECISION_META[decision].tone : STATUS_TONE[step.status];
  const StatusIcon = decision ? DECISION_META[decision].Icon : STATUS_ICON[step.status];
  const word = decision ? DECISION_META[decision].outcome : STEP_STATUS_LABEL[step.status];
  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm",
        running ? "brand-border shadow-[0_0_28px_-6px_var(--glow)]" : pending ? "border-dashed border-border" : "border-border",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="relative flex size-9 shrink-0">
          {running ? <span className="brand-fill absolute -inset-1 rounded-xl opacity-60 blur-md motion-safe:animate-pulse" /> : null}
          <span
            className={cn(
              "relative flex size-full items-center justify-center rounded-lg border",
              running ? "brand-fill border-transparent text-background" : SOFT_TONE[tone],
              pending && "opacity-60",
            )}
          >
            <Icon className="size-[18px]" strokeWidth={2} />
          </span>
        </span>
        <p className={cn("flex min-w-0 items-baseline gap-1.5 text-sm font-semibold", pending ? "text-muted-foreground" : "text-foreground")}>
          <span className="text-muted-foreground tabular-nums">{step.idx}</span>
          <span className="min-w-0 break-words">{step.label}</span>
        </p>
      </div>
      <p className="line-clamp-2 text-xs break-words text-muted-foreground">{question}</p>
      <p className={cn("mt-auto flex items-center gap-1 text-xs font-medium", running ? "text-accent-foreground" : INK_TONE[tone])}>
        <StatusIcon className={cn("size-3.5 shrink-0", running && "motion-safe:animate-spin")} />
        <span>{word}</span>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ the map */

export function PipelineFlow({ run }: { run: RunDetail }): JSX.Element {
  const headingId = `${useId()}-heading`;
  const byKey = new Map(run.steps.map((s) => [s.key, s]));
  const steps = STAGES.map((stage) => byKey.get(stage.key) ?? pendingStep(stage));
  const live = run.status === "queued" || run.status === "running";

  return (
    // Hidden on phones: ten stacked cards would push the stepper (the same stages, with details) far down the page.
    <section aria-labelledby={headingId} className="hidden rounded-xl bg-card ring-1 ring-foreground/10 sm:block">
      <div className="space-y-1 px-4 pt-4 pb-3 sm:px-5">
        <h2 id={headingId} className="text-base font-semibold">
          How this invoice moved through the 10 checks
        </h2>
        <p className="text-sm text-muted-foreground">Each check lights up as it runs. Details for every check are in the list below.</p>
      </div>
      {/* The canvas: a dotted night surface, measured by the container queries that choose the layout. */}
      <div className="@container rounded-b-xl border-t border-border bg-background/50 bg-[radial-gradient(circle,var(--border)_1px,transparent_1.5px)] bg-size-[18px_18px] p-4 sm:p-5">
        <div aria-hidden="true" className="grid grid-cols-1 gap-8 @lg:grid-cols-2 @5xl:grid-cols-5">
          {steps.map((step, i) => (
            <div key={step.key} data-stage={step.key} data-status={step.status} className={cn("relative min-w-0", SLOTS[i].place)}>
              <NodeCard step={step} decision={decisionOf(step, run)} />
              {SLOTS[i].outs.map(({ dir, show }) => (
                <Connector key={dir} dir={dir} link={linkInto(step, steps[i + 1], live)} show={show} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
