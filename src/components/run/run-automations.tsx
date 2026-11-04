"use client";

import Link from "next/link";
import { getRunAutomations, unwrap } from "@/components/shared/api";
import { usePoll } from "@/components/shared/use-poll";
import { ExecutionStatusMark } from "@/components/automations/execution-status";
import { displayText, formatDateTime } from "./run-format";

const POLL_MS = 1500;
/** Between a run committing and the dispatch inserting its rows there is a moment with nothing to see: keep looking this long. */
const SETTLE_MS = 3000;

export interface RunAutomationsProps {
  runId: string;
  /** the run is done or has failed: only then is there anything to look for */
  finished: boolean;
  finishedAt: string | null;
}

/**
 * What the automations did about this invoice (plan A9): which ran, how it went, who it was assigned to and the notes they
 * wrote, from GET /api/runs/:id/automations. It is the last thing on the run page, so it adds no Tab stop before the stepper.
 * Polls until nothing is queued or running and a few seconds have passed since the run finished. Text from automations
 * (names, notes, assignees) is plain text. Skipped for a pre-loaded history record by the caller.
 */
export function RunAutomations({ runId, finished, finishedAt }: RunAutomationsProps) {
  const { data } = usePoll((signal) => unwrap(getRunAutomations(runId, signal)), {
    enabled: finished,
    intervalMs: POLL_MS,
    resetKey: runId,
    until: (d) => d.pending === 0 && Date.now() - Date.parse(finishedAt ?? "") > SETTLE_MS,
  });
  if (!finished || data === null) return null;
  const live = data.executions.filter((e) => e.mode === "live");
  return (
    <section aria-labelledby={`automations-${runId}`} className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-6">
      <h2 id={`automations-${runId}`} className="text-xl font-semibold">
        Automations
      </h2>
      {live.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No automation ran for this invoice.{" "}
          <Link href="/automations" className="font-medium text-foreground underline underline-offset-4">
            Set up automations
          </Link>
        </p>
      ) : (
        <ul className="space-y-4">
          {live.map((e) => {
            const assigned = data.assignment !== null && data.assignment.workflow_name === e.workflow_name ? data.assignment : null;
            const notes = data.notes.filter((n) => n.workflow_name === e.workflow_name);
            return (
              <li key={e.id} data-execution={e.id} className="space-y-1">
                <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <Link href={`/automations/${encodeURIComponent(e.workflow_id)}`} prefetch={false} className="font-semibold text-foreground underline-offset-4 hover:underline">
                    {displayText(e.workflow_name, 60)}
                  </Link>
                  <ExecutionStatusMark status={e.status} />
                  <span className="text-sm text-muted-foreground">{formatDateTime(e.finished_at ?? e.created_at)}</span>
                </p>
                {e.error ? <p className="text-sm text-reject">{displayText(e.error, 200)}</p> : null}
                {assigned ? <p className="pl-4 text-sm">Assigned to {displayText(assigned.assignee, 60)}</p> : null}
                {notes.map((n, i) => (
                  <p key={i} className="pl-4 text-sm break-words">
                    Note: {displayText(n.text, 1000)}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
