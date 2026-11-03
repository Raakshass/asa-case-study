"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ArrowRight, History } from "lucide-react";
import { cn } from "cn";
import { DecisionBadge } from "@/components/shared/decision-badge";
import { ProgressBar } from "@/components/shared/progress-bar";
import { SecurityBadge } from "@/components/shared/security-badge";
import { EvidenceQuote, SecurityBanner } from "@/components/shared/security-banner";
import { Button } from "@/components/ui/button";
import type { Decision, RunDetail } from "@/lib/types";
import {
  DETECTOR_LABEL,
  buildSecurityEvidence,
  asStrings,
  displayText,
  formatCost,
  formatDate,
  formatDateTime,
  formatDuration,
  isRecord,
  runDurationMs,
  runProgress,
} from "./run-format";

/** How many reasons are shown before the rest goes behind a button (plan section 9: 1 to 5 sentences). */
const SHOWN_REASONS = 5;

const ACCENT: Record<Decision, string> = {
  APPROVE: "border-t-approve-solid",
  HOLD: "border-t-hold-solid",
  REJECT: "border-t-reject-solid",
};

const REASON_DOT: Record<Decision, string> = {
  APPROVE: "bg-approve-solid",
  HOLD: "bg-hold-solid",
  REJECT: "bg-reject-solid",
};

const REASON_TITLE: Record<Decision, string> = {
  APPROVE: "Approved, with notes",
  HOLD: "Why it is on hold",
  REJECT: "Why it was rejected",
};

const CARD = "rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-6";

/* ------------------------------------------------------------------------------------------------ pieces */

/** What each check reported, quoted as it reported it: behind a button, because the same sentence usually appears in all three. */
function RawFindings({ groups }: { groups: ReadonlyArray<{ title: string; quotes: string[] }> }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = groups.filter((g) => g.quotes.length > 0);
  const count = shown.reduce((n, g) => n + g.quotes.length, 0);
  if (count === 0) return null;
  return (
    <div className="space-y-3">
      <Button type="button" variant="outline" size="sm" className="bg-card" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide what each check reported" : `Show what each check reported (${count})`}
      </Button>
      {open ? (
        <div id={id} className="space-y-3">
          {shown.map((group) => (
            <div key={group.title} className="space-y-1.5">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{group.title}</p>
              {group.quotes.map((quote, i) => (
                <EvidenceQuote key={i}>{quote}</EvidenceQuote>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The shield banner of a security-flagged run, with what was found quoted once and which detectors caught it. */
function SecurityPanel({ run }: { run: RunDetail }) {
  const screen = run.steps.find((s) => s.key === "screen")?.detail ?? null;
  const extract = run.steps.find((s) => s.key === "extract")?.detail ?? null;
  const suspicious = run.extraction?.suspicious_content ?? (isRecord(extract) ? extract.suspicious_content : undefined);
  const evidence = buildSecurityEvidence({ injectionHits: screen?.injectionHits, hiddenText: screen?.hiddenText, suspicious });
  const raw = (value: unknown, cap: number) => asStrings(value, cap).map((s) => displayText(s, 600)).filter((s) => s !== "");
  return (
    <SecurityBanner className="mt-4">
      {evidence.items.map((item, i) => (
        <div key={i} className="space-y-1.5">
          <EvidenceQuote
            label={
              item.detectors.includes("hidden")
                ? "Hidden text found in the PDF (tiny, not visible when the page is viewed)"
                : item.detectors.includes("scan")
                  ? "Instruction-like text found in the PDF"
                  : "Reported by the model as suspicious"
            }
          >
            {item.text}
          </EvidenceQuote>
          <p className="text-xs text-muted-foreground">{`Caught by: ${item.detectors.map((d) => DETECTOR_LABEL[d]).join(", ")}.`}</p>
        </div>
      ))}
      {evidence.more > 0 ? (
        <p className="text-xs text-muted-foreground">{`${evidence.more} more ${evidence.more === 1 ? "quote is" : "quotes are"} in the Security screen and Extract fields stages below.`}</p>
      ) : null}
      <RawFindings
        groups={[
          { title: "Text scan: instruction-like passages", quotes: raw(screen?.injectionHits, 20) },
          { title: "Tiny-text check: hidden runs", quotes: raw(screen?.hiddenText, 10) },
          { title: "Model report: suspicious content", quotes: raw(suspicious, 20) },
        ]}
      />
      <p className="text-sm text-foreground">
        The model only reads invoices; the rules decide. A flagged invoice is never approved automatically: it goes to security review.
      </p>
    </SecurityBanner>
  );
}

/** Reasons as a list: the first five, the rest behind a real button. */
function Reasons({ reasons, decision, title }: { reasons: readonly string[]; decision: Decision | null; title: string }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const texts = reasons.map((r) => displayText(r, 1200)).filter((r) => r !== "");
  const shown = all ? texts : texts.slice(0, SHOWN_REASONS);
  const hidden = texts.length - SHOWN_REASONS;
  const dot = decision ? REASON_DOT[decision] : "bg-muted-foreground";
  if (texts.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      <ul id={listId} className="space-y-2">
        {shown.map((text, i) => (
          <li key={i} className="flex gap-2.5">
            <span aria-hidden="true" className={cn("mt-2 size-1.5 shrink-0 rounded-full", dot)} />
            <span className={cn("min-w-0 break-words [overflow-wrap:anywhere]", i === 0 ? "text-base font-medium" : "text-sm")}>{text}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <Button type="button" variant="outline" size="sm" aria-expanded={all} aria-controls={listId} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer reasons" : `Show ${hidden} more ${hidden === 1 ? "reason" : "reasons"}`}
        </Button>
      ) : null}
    </section>
  );
}

function NextAction({ text }: { text: string }) {
  const action = displayText(text, 600);
  if (action === "") return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Next action</h3>
      <p className="flex items-start gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-base font-medium">
        <ArrowRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-primary" />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{action}</span>
      </p>
    </section>
  );
}

function Meta({ run }: { run: RunDetail }) {
  const model = displayText(run.model, 80);
  const prompt = displayText(run.prompt_version, 60);
  const took = formatDuration(runDurationMs(run));
  const finished = formatDateTime(run.finished_at);
  const items: Array<[string, string, string?]> = [];
  if (model) items.push(["Model", model, model === "mock" ? "offline stand-in, no real model was called" : undefined]);
  if (prompt) items.push(["Prompt", prompt]);
  if (took) items.push(["Took", took]);
  items.push(["Cost", formatCost(run.cost_usd)]);
  if (finished) items.push(["Finished", finished]);
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-border pt-4 text-sm">
      {items.map(([label, value, hint]) => (
        <div key={label} className="flex min-w-0 gap-1.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 font-medium break-words">
            {value}
            {hint ? <span className="font-normal text-muted-foreground">{` (${hint})`}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------------------------------------ the card */

export interface DecisionCardProps {
  run: RunDetail;
}

/**
 * The top of the run page. While the run is queued or running: "Processing... stage k of 10" with a progress
 * bar. When it is done: the big decision badge, the shield banner for a flagged run (the hidden text quoted),
 * the reasons, the next action, and the model, prompt, duration and cost. A run that stopped without a decision
 * shows its reason and next action under an Error badge; a pre-loaded history run says what it is.
 */
export function DecisionCard({ run }: DecisionCardProps) {
  const headingId = useId();

  if (run.is_history) {
    const processed = formatDate(run.finished_at ?? run.created_at);
    return (
      <section aria-labelledby={headingId} className={cn(CARD, "border-t-4", run.decision ? ACCENT[run.decision] : "border-t-border")}>
        <div className="flex flex-wrap items-center gap-3">
          <DecisionBadge decision={run.decision} runStatus={run.status} size="lg" variant="solid" />
          <h2 id={headingId} className="flex items-center gap-2 text-lg font-semibold sm:text-xl">
            <History aria-hidden="true" className="size-5 text-muted-foreground" />
            Processed before the demo
          </h2>
        </div>
        <p className="mt-3 max-w-prose text-sm text-muted-foreground">
          {`This invoice was processed before the demo${processed ? ` (${processed})` : ""}. It counts toward purchase order balances and the duplicate check, but it has no pipeline steps and no stored PDF.`}
        </p>
      </section>
    );
  }

  if (run.status === "queued" || run.status === "running") {
    const progress = runProgress(run);
    const queued = run.status === "queued" && progress.settled === 0;
    return (
      <section aria-labelledby={headingId} aria-busy="true" className={cn(CARD, "border-t-4 border-t-primary")}>
        <div className="flex flex-wrap items-center gap-3">
          <DecisionBadge decision={null} runStatus={run.status} size="lg" />
          <h2 id={headingId} className="text-lg font-semibold sm:text-xl">
            {queued ? "Waiting for its turn..." : `Processing... stage ${progress.current} of ${progress.total}`}
          </h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {queued
            ? "Invoices are processed one at a time. This one starts as soon as the runs before it have finished."
            : `Now: ${progress.currentLabel}. The agent reads the invoice, the rules decide, and every stage is shown below as it finishes.`}
        </p>
        <ProgressBar
          value={progress.settled}
          max={progress.total}
          label="Pipeline progress"
          valueText={queued ? "Waiting to start" : `${progress.settled} of ${progress.total} stages finished`}
          className="mt-4 h-2.5"
        />
      </section>
    );
  }

  const errored = run.status === "error";
  const decision = run.decision;
  const reasons = run.decision_reasons;
  return (
    <section aria-labelledby={headingId} className={cn(CARD, "border-t-4", errored || !decision ? "border-t-reject-solid" : ACCENT[decision])}>
      <div className="flex flex-wrap items-center gap-3">
        <DecisionBadge decision={decision} runStatus={run.status} size="lg" variant="solid" />
        {run.security_flag ? <SecurityBadge size="lg" /> : null}
        <h2 id={headingId} className="min-w-0 text-lg font-semibold sm:text-xl">
          {errored ? "This run stopped before it reached a decision" : "Decision"}
        </h2>
      </div>

      {run.security_flag ? <SecurityPanel run={run} /> : null}

      <div className="mt-5 space-y-5">
        {reasons.length > 0 ? (
          <Reasons reasons={reasons} decision={decision} title={errored ? "What happened" : decision ? REASON_TITLE[decision] : "Reasons"} />
        ) : decision === "APPROVE" ? (
          <p className="text-base font-medium">All checks passed.</p>
        ) : null}
        {run.next_action ? <NextAction text={run.next_action} /> : null}
        {errored ? (
          <Button asChild variant="outline" size="lg">
            <Link href="/runs/new">Start a new run</Link>
          </Button>
        ) : null}
        <Meta run={run} />
      </div>
    </section>
  );
}
