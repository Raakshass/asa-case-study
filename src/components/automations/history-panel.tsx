"use client";

import { useEffect, useState } from "react";
import { getExecution, getExecutions, unwrap } from "@/components/shared/api";
import { usePoll } from "@/components/shared/use-poll";
import { Button } from "@/components/ui/button";
import { StepStatusIcon } from "@/components/shared/step-status-icon";
import { displayText, formatWhen } from "@/components/dashboard/run-format";
import { formatDuration } from "@/components/run/run-format";
import type { ExecutionDetail, ExecutionListItem, ExecutionStep } from "@/lib/types";
import { ExecutionStatusMark } from "./execution-status";

export interface HistoryPanelProps {
  automationId: string;
  /** the execution to open right away (after a test) */
  openId: string | null;
  /** the shown execution changed: the editor draws it as an overlay on the canvas (null: back to editing) */
  onOverlay: (detail: ExecutionDetail | null) => void;
  /** bumped by the editor when something may have been added (a test was started) */
  refreshKey: number;
}

const finished = (d: { status: string }): boolean => d.status === "success" || d.status === "error";

/** The trigger in words: "Invoice GLX-303 on hold", "Test with GLX-303", "Schedule, 3 Nov 08:00 UTC". */
function triggerWords(e: ExecutionListItem): string {
  const label = e.run_label === null ? "an invoice" : displayText(e.run_label, 80);
  if (e.trigger_type === "test") return e.run_label === null ? "Test" : `Test with ${label}`;
  if (e.trigger_type === "schedule") return "Schedule";
  if (e.trigger_type === "review_saved") return `Hold resolved: ${label}`;
  return `Invoice ${label}`;
}

function took(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return formatDuration(Date.parse(b) - Date.parse(a));
}

/** One step of the shown execution, with what it did (output as text, never markup). */
function StepLine({ step, mode }: { step: ExecutionStep; mode: ExecutionDetail["mode"] }) {
  const out = step.output as Record<string, unknown> | null;
  const preview = out !== null && typeof out === "object" ? (out.preview as { host?: string | null } | undefined) : undefined;
  const notWritten = out !== null && typeof out === "object" && ("would_write" in out || "would_assign" in out);
  const json = step.output === null || step.output === undefined ? null : JSON.stringify(step.output, null, 2);
  const text = json === null ? null : json.length > 4000 ? `${json.slice(0, 4000)}…` : json;
  return (
    <li className="space-y-1 rounded-lg bg-card p-2.5 ring-1 ring-foreground/10">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="font-medium">{step.name}</span>
        <span className="inline-flex items-center gap-1.5 text-sm">
          <StepStatusIcon status={step.status === "success" ? "pass" : step.status === "error" ? "error" : "skipped"} size="sm" />
          {step.status === "success" ? "Succeeded" : step.status === "error" ? "Failed" : "Skipped"}
        </span>
        {step.attempts > 0 && (step.attempts > 1 || step.type === "action.webhook" || step.type === "action.chat") ? <span className="text-sm text-muted-foreground">{step.attempts} {step.attempts === 1 ? "attempt" : "attempts"}</span> : null}
      </p>
      {step.error ? <p className="text-sm text-reject">{step.error}</p> : null}
      {notWritten && mode !== "live" ? <p className="text-sm text-muted-foreground">Not written (test).</p> : null}
      {preview !== undefined ? (
        <p className="text-sm text-muted-foreground">{preview.host === null || preview.host === undefined ? "Not sent (test). No URL is set yet; this is what would be sent:" : `Not sent (test). This is what would be sent to ${displayText(preview.host, 100)}:`}</p>
      ) : null}
      {text !== null ? <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{text}</pre> : null}
    </li>
  );
}

/**
 * The History panel (plan 8.2 and 8.6): the newest executions of this automation, and one opened (its trigger in words, when
 * it started and how long it took, each step with what it did). Opening one draws it on the canvas as a read-only overlay
 * until "Back to editing". The open execution is polled every second while it is queued or running.
 */
export function HistoryPanel({ automationId, openId, onOverlay, refreshKey }: HistoryPanelProps) {
  const [selected, setSelected] = useState<string | null>(openId);
  useEffect(() => {
    if (openId !== null) setSelected(openId);
  }, [openId]);

  const list = usePoll((signal) => unwrap(getExecutions(automationId, 25, signal)), { intervalMs: 5000, resetKey: `${automationId}:${refreshKey}` });
  const detail = usePoll((signal) => unwrap(getExecution(selected as string, signal)), {
    enabled: selected !== null,
    intervalMs: 1000,
    until: finished,
    resetKey: selected ?? "none",
  });
  const shown = selected !== null ? detail.data : null;

  useEffect(() => {
    onOverlay(shown);
    // the overlay follows the polled detail; clearing happens through "Back to editing" or unmount
  }, [shown, onOverlay]);
  useEffect(() => () => onOverlay(null), [onOverlay]);

  const executions = list.data?.executions ?? [];
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">History</h2>
      {selected !== null ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setSelected(null)} className="h-8 px-3">
          Back to editing
        </Button>
      ) : null}
      {list.loading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
      {!list.loading && executions.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has run yet. Use &ldquo;Test with an invoice&rdquo; to try it.</p> : null}
      <ul className="space-y-1.5" aria-label="Executions">
        {executions.map((e) => {
          const when = formatWhen(e.created_at);
          return (
            <li key={e.id}>
              <button
                type="button"
                aria-pressed={selected === e.id}
                onClick={() => setSelected(e.id)}
                className={`w-full rounded-lg p-2 text-left ring-1 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none ${selected === e.id ? "bg-muted ring-foreground/30" : "bg-card ring-foreground/10"}`}
              >
                <span className="block text-sm text-muted-foreground">{when?.text ?? "Unknown time"}</span>
                <span className="block text-sm break-words">{triggerWords(e)}</span>
                <ExecutionStatusMark status={e.status} />
              </button>
            </li>
          );
        })}
      </ul>

      {selected !== null ? (
        <section aria-label="The execution shown" className="space-y-2 border-t pt-4">
          {shown === null ? (
            <p className="text-sm text-muted-foreground">{detail.error ? detail.error.message : "Loading..."}</p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <ExecutionStatusMark status={shown.status} />
                <span className="text-sm text-muted-foreground">
                  {shown.created_at ? `Started ${formatWhen(shown.created_at)?.text ?? ""}` : ""}
                  {took(shown.created_at, shown.finished_at) ? `, took ${took(shown.created_at, shown.finished_at)}` : ""}
                </span>
              </p>
              <p className="text-sm">{triggerWords(shown)}</p>
              {shown.error ? <p className="text-sm text-reject">{shown.error}</p> : null}
              <ol className="space-y-2">
                {shown.steps.map((s) => (
                  <StepLine key={s.node_id} step={s} mode={shown.mode} />
                ))}
              </ol>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
