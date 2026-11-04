"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowLeft, TriangleAlert, Upload } from "lucide-react";
import { ApiFailure, getRun, getRuns, unwrap } from "@/components/shared/api";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { usePoll } from "@/components/shared/use-poll";
import { Button } from "@/components/ui/button";
import type { RunDetail } from "@/lib/types";
import { DecisionCard } from "./decision-card";
import { ExtractedFields } from "./extracted-fields";
import { HistoryRecord } from "./history-record";
import { PdfPanel } from "./pdf-panel";
import { RunAutomations } from "./run-automations";
import { ReviewPanel } from "./review-panel";
import { InvalidRun, RunNotFound, RunSkeleton } from "./run-states";
import { displayText, formatDate, formatDateTime, isUuid } from "./run-format";
import { Stepper } from "./stepper";

/** The run is polled this often until it is done or has failed (docs/CONTRACTS.md section 7). */
const POLL_MS = 400;

const isFinished = (run: RunDetail): boolean => run.status === "done" || run.status === "error";

/** 400 (not a run id) and 404 (no such run) will not fix themselves: stop polling. Anything else is transient. */
const isGone = (error: Error): boolean => error instanceof ApiFailure && (error.status === 400 || error.status === 404);

function gone(error: Error | null, status: 400 | 404): boolean {
  return error instanceof ApiFailure && error.status === status;
}

function Header({ run, actions }: { run: RunDetail | null; actions: boolean }) {
  const name = run ? displayText(run.file_name, 100) : "";
  const when = run ? (run.is_history ? formatDate(run.finished_at ?? run.created_at) : formatDateTime(run.created_at)) : null;
  return (
    <PageHeader
      title={run?.is_history ? "Pre-loaded history record" : name || "Invoice run"}
      description={run && when ? (run.is_history ? `Processed on ${when}` : `Started ${when}`) : undefined}
      actions={
        actions ? (
          <>
            <Button asChild size="lg" variant="outline">
              <Link href="/">
                <ArrowLeft aria-hidden="true" />
                Dashboard
              </Link>
            </Button>
            <Button asChild size="lg">
              <Link href="/runs/new">
                <Upload aria-hidden="true" />
                Run another invoice
              </Link>
            </Button>
          </>
        ) : undefined
      }
    />
  );
}

export interface RunViewProps {
  id: string;
}

/**
 * The live run view. It polls GET /api/runs/<id> every 400 ms until the run is done or has failed (usePoll stops
 * on unmount and keeps the previous data while it refetches, so nothing flickers) and draws, from one RunDetail:
 * the decision card, the stepper, the PDF and the extracted fields. Loading shows a skeleton; a 400 or 404 shows a
 * friendly page with a way home; a network error shows a retry (and, once data is on screen, a notice that live
 * updates are paused). A pre-loaded history record shows its facts instead of the stepper.
 */
export function RunView({ id }: RunViewProps) {
  const [retrying, setRetrying] = useState(false);
  // An id that cannot be a run id is never sent to the API (which would only answer 400): the friendly page shows at once.
  const wellFormed = isUuid(id);
  const { data: run, error, refresh } = usePoll<RunDetail>((signal) => unwrap(getRun(id, signal)), {
    enabled: wellFormed,
    intervalMs: POLL_MS,
    resetKey: id,
    until: isFinished,
    stopOnError: isGone,
  });

  // A pre-loaded record carries none of its invoice's fields; read them from the list, once (no polling).
  const history = run?.is_history === true && !gone(error, 404);
  const list = usePoll((signal) => unwrap(getRuns({ limit: 200 }, signal)), { intervalMs: 0, enabled: history, resetKey: id });
  const entry = history ? (list.data?.runs.find((r) => r.id === id) ?? null) : null;

  const retry = useCallback(() => {
    setRetrying(true);
    void refresh().finally(() => setRetrying(false));
  }, [refresh]);

  const invalid = !wellFormed || gone(error, 400);
  // A run removed while it was on screen (a demo reset) counts as not found too, whatever data is left over.
  const missing = gone(error, 404);

  let body: React.ReactNode;
  if (invalid) {
    body = <InvalidRun />;
  } else if (missing) {
    body = <RunNotFound />;
  } else if (run) {
    body = (
      <div className="space-y-6">
        {error ? (
          <p role="status" className="flex items-start gap-2 text-sm text-hold">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong className="font-semibold">Live updates paused.</strong> {error.message} Retrying automatically; what is shown may be out of date.
            </span>
          </p>
        ) : null}
        <DecisionCard run={run} />
        {run.status === "done" && run.decision === "HOLD" && run.review === null && !run.is_history ? <ReviewPanel run={run} onReviewed={() => void refresh()} /> : null}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
          <div className="min-w-0 space-y-6">
            {run.is_history ? <HistoryRecord run={run} entry={entry} loading={list.loading} /> : <Stepper run={run} />}
          </div>
          <div className="min-w-0 space-y-6">
            <PdfPanel run={run} />
            {run.is_history ? null : <ExtractedFields run={run} />}
          </div>
        </div>
        {run.is_history ? null : <RunAutomations runId={run.id} finished={run.status === "done" || run.status === "error"} finishedAt={run.finished_at} />}
      </div>
    );
  } else if (error) {
    body = <ErrorState title="Could not load this run" message={error.message} onRetry={retry} retrying={retrying} />;
  } else {
    body = <RunSkeleton />;
  }

  // Announced politely once, when the run ends (the visible progress text changes too often to be read out).
  const announcement =
    run?.status === "done" ? `Run finished: ${run.decision ?? "no decision"}.` : run?.status === "error" ? "The run stopped with an error." : "";

  return (
    <>
      <Header run={invalid || missing ? null : run} actions={!(invalid || missing)} />
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {body}
    </>
  );
}
