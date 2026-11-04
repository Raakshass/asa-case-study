"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getRuns, unwrap } from "@/components/shared/api";
import { Button } from "@/components/ui/button";
import { displayText, formatWhen } from "@/components/dashboard/run-format";
import type { RunListItem } from "@/lib/types";
import type { AutomationTriggerType } from "@/lib/types";

const DECISION_WORD: Record<string, string> = { APPROVE: "Approved", HOLD: "On hold", REJECT: "Rejected" };

const SELECT = "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

export interface TestDialogProps {
  open: boolean;
  triggerType: AutomationTriggerType;
  /** the graph has a webhook or chat step */
  hasSending: boolean;
  sendingEnabled: boolean;
  busy: boolean;
  error: string | null;
  /** the operator-token form, drawn inside the dialog: the page behind a modal dialog is inert, so a form outside it could not be used */
  prompt: ReactNode;
  onClose: () => void;
  onRun: (input: { runId: string | null; send: boolean }) => void;
}

/** "<invoice no. or file>, <vendor>, <decision word>, <date>" for a past run. */
function runLabel(r: RunListItem): string {
  const when = formatWhen(r.created_at, { dateOnly: true })?.text ?? "";
  return [displayText(r.invoice_number ?? r.file_name ?? "unnamed file", 60), displayText(r.vendor_name, 60), r.decision === null ? "no decision" : (DECISION_WORD[r.decision] ?? r.decision), when].filter((x) => x !== "").join(", ");
}

/**
 * "Test with an invoice" (plan 8.3): a native <dialog> with the newest 50 real (not pre-loaded) runs to test against, a
 * checkbox to send for real (only when the automation has a sending step, and disabled with a reason while sending is off),
 * and Run test. A schedule automation has no invoice to choose: it runs with the invoices of its own window.
 */
export function TestDialog({ open, triggerType, hasSending, sendingEnabled, busy, error, prompt, onClose, onRun }: TestDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [send, setSend] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open || triggerType === "schedule") return;
    const ctl = new AbortController();
    void unwrap(getRuns({ limit: 50 }, ctl.signal)).then(
      (res) => {
        const real = res.runs.filter((r) => !r.is_history && (r.status === "done" || r.status === "error") && (triggerType !== "review_saved" || r.reviewed !== null));
        setRuns(real);
        setChoice((c) => (c !== "" && real.some((r) => r.id === c) ? c : (real[0]?.id ?? "")));
      },
      (e: unknown) => {
        if (!ctl.signal.aborted) setRunError(e instanceof Error ? e.message : "Could not load the invoices.");
      },
    );
    return () => ctl.abort();
  }, [open, triggerType]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    onRun({ runId: triggerType === "schedule" ? null : choice === "" ? null : choice, send: send && hasSending && sendingEnabled });
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${uid}-title`}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl bg-card p-0 text-foreground shadow-lg ring-1 ring-foreground/15 backdrop:bg-foreground/30"
    >
      <form onSubmit={submit} className="space-y-4 p-4 sm:p-5">
        <h2 id={`${uid}-title`} className="text-xl font-semibold">
          Test with an invoice
        </h2>
        {triggerType === "schedule" ? (
          <p className="text-sm">This automation runs on a schedule, so the test runs with the invoices of its own time window.</p>
        ) : (
          <div className="space-y-1.5">
            <label htmlFor={`${uid}-run`} className="text-sm font-medium">
              Invoice
            </label>
            {runs === null && runError === null ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
            {runError ? <p role="alert" className="text-sm text-reject">{runError}</p> : null}
            {runs !== null && runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{triggerType === "review_saved" ? "No invoice has been reviewed yet." : "No finished invoice yet. Run a sample first."}</p>
            ) : null}
            {runs !== null && runs.length > 0 ? (
              <select id={`${uid}-run`} value={choice} onChange={(e) => setChoice(e.target.value)} className={SELECT}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {runLabel(r)}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        )}
        {hasSending ? (
          <div className="space-y-1">
            <label className="flex min-h-6 items-center gap-2 text-sm">
              <input type="checkbox" checked={send && sendingEnabled} disabled={!sendingEnabled} onChange={(e) => setSend(e.target.checked)} className="size-4" />
              Send to the webhooks for real
            </label>
            {!sendingEnabled ? <p className="text-sm text-muted-foreground">Sending is off on this server, so steps that send show a preview instead.</p> : null}
          </div>
        ) : null}
        {prompt}
        {error ? (
          <p role="alert" className="text-sm text-reject">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" size="lg" onClick={onClose} className="h-10 px-4">
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={busy || (triggerType !== "schedule" && choice === "")} className="h-10 px-4">
            {busy ? "Starting..." : "Run test"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
