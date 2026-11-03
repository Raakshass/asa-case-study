"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { formatWhen } from "@/components/dashboard/run-format";
import { getRuns, getSamples, unwrap } from "@/components/shared/api";
import { DECISION_META, DecisionBadge } from "@/components/shared/decision-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { CardSkeleton } from "@/components/shared/skeletons";
import { usePoll } from "@/components/shared/use-poll";
import type { RunListItem, SampleListItem } from "@/lib/types";

// grid-cols-1 is explicit (minmax(0, 1fr)) so one long unbroken word cannot widen the single column of a phone
const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";

/** Disabling the button that has focus drops focus to the page: true when that happened (and nothing else took it). */
function focusWasLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

export interface SampleCardProps {
  sample: SampleListItem;
  /** A run is being started (this sample or something else): the card cannot be pressed. */
  disabled: boolean;
  /** This sample is the one being started: shows a spinner and "Starting". */
  starting: boolean;
  onPick: (sample: SampleListItem) => void;
}

/**
 * One sample invoice as a card that is a single real button: title, the one-line scenario and the outcome the
 * rules are expected to reach. Pressing it starts a run of that sample. All text comes from the API and is
 * rendered as plain text. The whole card is the click target; its accessible name is its text.
 */
export function SampleCard({ sample, disabled, starting, onPick }: SampleCardProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const wasStarting = useRef(false);
  // A failed start re-enables the card, which lost focus while it was disabled: give focus back to it.
  useEffect(() => {
    if (wasStarting.current && !starting && focusWasLost()) ref.current?.focus();
    wasStarting.current = starting;
  }, [starting]);
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-busy={starting || undefined}
      data-sample={sample.file}
      onClick={() => onPick(sample)}
      className={cn(
        // flex-1: the card fills its grid cell (a column flex box), with room under it for a failed start's message
        "group flex w-full flex-1 flex-col gap-3 rounded-xl bg-card p-4 text-left text-card-foreground ring-1 ring-foreground/10 transition-colors",
        "hover:bg-accent/40 hover:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        starting && "bg-accent/40 ring-primary/40 disabled:opacity-100",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0 text-base font-semibold break-words">{sample.title}</span>
        {sample.edge_case ? (
          <span className="shrink-0 text-sm whitespace-nowrap text-muted-foreground">Edge case {sample.edge_case}</span>
        ) : null}
      </span>
      <span className="block text-sm break-words text-muted-foreground">{sample.scenario}</span>
      <span className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-1">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          Expected
          <DecisionBadge decision={sample.expected} size="sm" />
        </span>
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
          {starting ? (
            <>
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              Starting
            </>
          ) : (
            <>
              Run this sample
              <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
            </>
          )}
        </span>
      </span>
    </button>
  );
}

/**
 * Why the pressed card could not start its run (a 429 with its wait, a 5xx, no connection), right under that card:
 * above the grid it was off screen for most cards (routes-ui UI-2). It is an alert (announced), and it is scrolled
 * into view only as far as needed when it appears, so the visitor keeps their place.
 */
function CardProblem({ title, message }: { title: string; message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [title, message]);
  return (
    <div ref={ref} data-sample-problem="true">
      <ErrorState title={title} message={message} />
    </div>
  );
}

/**
 * "Ran Nov 3, 11:42 AM: Approved" and a link to that run, under a sample that already has a run (review round B8): pressing the
 * same sample twice before a reset makes a REJECT ("Exact same file already processed"), which is correct but surprising.
 * A sibling of the card's button, never inside it.
 */
function PriorResult({ file, run }: { file: string; run: RunListItem }) {
  const when = formatWhen(run.created_at);
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground" data-sample-result={file}>
      <span>{`Ran ${when?.text ?? "earlier"}: ${run.decision ? DECISION_META[run.decision].outcome : "not finished"}`}</span>
      <Link href={`/runs/${encodeURIComponent(run.id)}`} className="inline-flex min-h-6 items-center font-medium text-primary underline-offset-4 hover:underline">
        Open result
      </Link>
    </p>
  );
}

export interface SampleSectionProps {
  /** A run is being started (an upload or any sample): every card is switched off. */
  disabled: boolean;
  /** The file name of the sample being started, or null. */
  startingFile: string | null;
  onPick: (sample: SampleListItem) => void;
  /** A failed start of one sample: shown under that sample's card. */
  problem?: { file: string; title: string; message: string } | null;
}

/**
 * The sample cards in two groups (everyday cases, edge cases), loaded once from GET /api/samples (it never changes while the page is open).
 * Shows a skeleton while loading, an error with a retry button when the list cannot be loaded, and a note
 * when the server has no sample files.
 */
export function SampleSection({ disabled, startingFile, onPick, problem = null }: SampleSectionProps) {
  const [retrying, setRetrying] = useState(false);
  const { data, error, loading, refresh } = usePoll((signal) => unwrap(getSamples(signal)), { intervalMs: 0 });
  // The newest run of each sample file (the list is newest first), so a card can say it already ran. Loaded once; a failure just shows nothing.
  const runs = usePoll((signal) => unwrap(getRuns({ limit: 200 }, signal)), { intervalMs: 0 });
  const lastRun = new Map<string, RunListItem>();
  for (const run of runs.data?.runs ?? []) {
    if (run.is_history || run.file_name === null || lastRun.has(run.file_name)) continue;
    lastRun.set(run.file_name, run);
  }

  const retry = useCallback(() => {
    setRetrying(true);
    void refresh().finally(() => setRetrying(false));
  }, [refresh]);

  if (loading) {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading the sample invoices</span>
        <div aria-hidden="true" className={GRID}>
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} lines={3} />
          ))}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <ErrorState
        title="Could not load the samples"
        message={error?.message ?? "The sample list is not available."}
        onRetry={retry}
        retrying={retrying}
      />
    );
  }
  if (data.length === 0) {
    return (
      <EmptyState
        title="No sample invoices on this server"
        description="The sample PDFs were not found. You can still upload your own invoice above."
      />
    );
  }
  // Two grouped lists: the everyday cases, then the ones that probe an edge of the rules.
  const groups = [
    { title: "Everyday cases", samples: data.filter((s) => !s.edge_case) },
    { title: "Edge cases", samples: data.filter((s) => s.edge_case) },
  ].filter((g) => g.samples.length > 0);
  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <section key={group.title} className="space-y-3">
          <h3 className="text-base font-semibold">{group.title}</h3>
          <ul className={GRID}>
            {group.samples.map((sample) => (
              <li key={sample.file} className="flex flex-col gap-2">
                <SampleCard sample={sample} disabled={disabled} starting={startingFile === sample.file} onPick={onPick} />
                {lastRun.has(sample.file) ? <PriorResult file={sample.file} run={lastRun.get(sample.file) as RunListItem} /> : null}
                {problem !== null && problem.file === sample.file ? <CardProblem title={problem.title} message={problem.message} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
