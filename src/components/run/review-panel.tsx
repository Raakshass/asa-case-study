"use client";

import { useId, useState, type FormEvent } from "react";
import { ClipboardCheck } from "lucide-react";
import { reviewRun } from "@/components/shared/api";
import { forgetToken, readSavedToken, saveToken } from "@/components/shared/operator-token";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BANK_REVIEW_PREFIX, SECURITY_REVIEW_PREFIX, type ReviewAction, type RunDetail } from "@/lib/types";

const COMMENT_MIN = 10;
const COMMENT_MAX = 500;

const FIELD = "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

/** The PO numbers the matcher considered, as strings only: the step's detail is untyped JSON. */
function candidatesOf(run: RunDetail): string[] {
  const list = run.steps.find((s) => s.key === "po_match")?.detail?.candidates;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.length <= 40).slice(0, 20) : [];
}

/** Whether the PO has to be chosen by the reviewer: it was inferred, or there is none. */
function needsPoChoice(run: RunDetail): boolean {
  const detail = run.steps.find((s) => s.key === "po_match")?.detail;
  return detail?.inferred === true || typeof detail?.po_number !== "string";
}

function bankFlagged(run: RunDetail): boolean {
  const detail = run.steps.find((s) => s.key === "vendor")?.detail;
  return detail?.bank_mismatch === true || detail?.bank_change_notice === true;
}

export interface ReviewPanelProps {
  run: RunDetail;
  /** Called after a review was saved: the page refetches the run. */
  onReviewed: () => void;
}

/**
 * Resolve a hold (review round B4). Shown under the decision card for a finished run that is on hold and has not been
 * reviewed. One button opens a form: the outcome, the PO when it has to be chosen, what was checked, and the operator
 * token (kept in this tab's sessionStorage like the reset panel's). The server decides whether the review is allowed and
 * answers with a fixed sentence; it is shown as plain text.
 */
export function ReviewPanel({ run, onReviewed }: ReviewPanelProps) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [po, setPo] = useState("");
  const [comment, setComment] = useState("");
  const [token, setToken] = useState(() => (typeof window === "undefined" ? "" : readSavedToken()));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const candidates = candidatesOf(run);
  const showPo = action === "APPROVE" && needsPoChoice(run);
  // Only an invoice can be approved (the server enforces it; the form only saves the person from a refusal).
  const canApprove = run.extraction?.document_type === "invoice";
  const hint =
    run.security_flag && bankFlagged(run)
      ? `Start with "${SECURITY_REVIEW_PREFIX}" and also write "${BANK_REVIEW_PREFIX}" to approve.`
      : run.security_flag
        ? `Start with "${SECURITY_REVIEW_PREFIX}" to approve.`
        : bankFlagged(run)
          ? `Start with "${BANK_REVIEW_PREFIX}" to approve.`
          : null;
  const length = comment.trim().length;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || action === null) return;
    setPending(true);
    setError(null);
    const result = await reviewRun(run.id, { action, comment, po_number: showPo && po.trim() !== "" ? po.trim() : null }, token);
    setPending(false);
    if (result.ok) {
      saveToken(token.trim());
      onReviewed();
      return;
    }
    if (result.status === 403) forgetToken();
    setError(result.error);
  }

  return (
    <section aria-labelledby={`${uid}-title`} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={`${uid}-title`} className="text-base font-semibold">
            Resolve this hold
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">Someone has checked it? Record what they decided. The machine&apos;s reasons stay as they are.</p>
        </div>
        <Button type="button" variant="outline" size="lg" aria-expanded={open} aria-controls={`${uid}-form`} onClick={() => setOpen((o) => !o)} className="h-10 px-3">
          <ClipboardCheck aria-hidden="true" />
          Resolve this hold
        </Button>
      </div>
      <div id={`${uid}-form`} hidden={!open}>
        {open ? (
          <form onSubmit={submit} autoComplete="off" className="mt-4 space-y-4 border-t pt-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Outcome</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {(
                  [
                    ["APPROVE", "Approve after review"],
                    ["REJECT", "Reject"],
                  ] as const
                )
                  .filter(([value]) => canApprove || value === "REJECT")
                  .map(([value, label]) => (
                    <label key={value} className="flex min-h-6 items-center gap-2 text-sm">
                      <input type="radio" name={`${uid}-action`} value={value} checked={action === value} onChange={() => setAction(value)} className="size-4" />
                      {label}
                    </label>
                  ))}
              </div>
              {canApprove ? null : <p className="text-sm text-muted-foreground">Only an invoice can be approved. This document can only be rejected here.</p>}
            </fieldset>

            {showPo ? (
              <div className="space-y-1.5">
                <label htmlFor={`${uid}-po`} className="text-sm font-medium">
                  {candidates.length > 0 ? "PO" : "PO number"}
                </label>
                {candidates.length > 0 ? (
                  <select id={`${uid}-po`} value={po} onChange={(e) => setPo(e.target.value)} className={`${FIELD} h-9 sm:max-w-xs`} required>
                    <option value="">Choose a PO</option>
                    {candidates.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input id={`${uid}-po`} value={po} onChange={(e) => setPo(e.target.value)} maxLength={40} className="h-9 sm:max-w-xs" required />
                )}
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor={`${uid}-comment`} className="text-sm font-medium">
                What was checked
              </label>
              <textarea
                id={`${uid}-comment`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                maxLength={COMMENT_MAX}
                required
                aria-describedby={`${uid}-comment-hint`}
                className={`${FIELD} min-h-20`}
              />
              <p id={`${uid}-comment-hint`} className="text-sm text-muted-foreground">
                {`${COMMENT_MIN} to ${COMMENT_MAX} characters (${length} so far). `}
                {hint}
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor={`${uid}-token`} className="text-sm font-medium">
                Operator token
              </label>
              <Input id={`${uid}-token`} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} className="h-9 sm:max-w-xs" required />
            </div>

            {error ? (
              <p role="alert" className="text-sm text-reject">
                {error}
              </p>
            ) : null}
            <Button type="submit" size="lg" disabled={pending || action === null} className="h-10 px-4">
              {pending ? "Saving..." : "Save review"}
            </Button>
          </form>
        ) : null}
      </div>
    </section>
  );
}
