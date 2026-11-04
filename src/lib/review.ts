/**
 * A person resolves a HOLD (review round B4). `runs` and `run_steps` stay append-only: they are what the machine decided,
 * forever. `run_reviews` records what a person decided, once per run, and the `invoices` row (the invoice's current
 * state) takes the reviewed decision, so the PO balance and the duplicate check see it. Only a finished run that is on
 * hold can be reviewed, and a REJECT is final. Every message is fixed text; the comment is the reviewer's own words and
 * is only ever stored and shown as plain text. Called by POST /api/runs/:id/review through the pipeline's chain, so it
 * never interleaves with a run that is spending PO balance. Server-only. It never decides anything by itself: the
 * reviewer decides, this file only checks that what they ask is allowed.
 */
import crypto from "node:crypto";
import { CONFIG } from "./config";
import type { DB } from "./db";
import { formatUsd, normId, round2 } from "./format";
import { consumedAmount, loadSnapshot, remainingBalance } from "./master";
import { BANK_REVIEW_PREFIX, SECURITY_REVIEW_PREFIX, type ReviewRequest, type RunReview } from "./types";

export type ReviewOutcome = { ok: true; review: RunReview } | { ok: false; status: 400 | 404 | 409; error: string };

const fail = (status: 400 | 404 | 409, error: string): ReviewOutcome => ({ ok: false, status, error });

export const COMMENT_MIN = 10;
export const COMMENT_MAX = 500;

/** Control characters become spaces, whitespace collapses, the ends are trimmed. */
function cleanComment(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/** True when the run's vendor step reported new or different bank details. */
function bankFlagged(db: DB, runId: string): boolean {
  const text = db.prepare("SELECT detail FROM run_steps WHERE run_id = ? AND key = 'vendor'").pluck().get(runId) as string | null | undefined;
  if (typeof text !== "string") return false;
  try {
    const detail = JSON.parse(text) as { bank_mismatch?: unknown; bank_change_notice?: unknown } | null;
    return detail?.bank_mismatch === true || detail?.bank_change_notice === true;
  } catch {
    return false;
  }
}

export function reviewRun(db: DB, runId: string, input: ReviewRequest, now: Date = new Date()): ReviewOutcome {
  return db.transaction((): ReviewOutcome => {
    const run = db.prepare("SELECT status, decision, security_flag FROM runs WHERE id = ?").get(runId) as
      | { status: string; decision: string | null; security_flag: number }
      | undefined;
    if (run === undefined) return fail(404, "Run not found.");
    if (run.status !== "done" || run.decision !== "HOLD") return fail(409, "Only a finished run that is on hold can be reviewed.");
    if (db.prepare("SELECT 1 FROM run_reviews WHERE run_id = ?").get(runId) !== undefined) return fail(409, "This run has already been reviewed.");

    const comment = cleanComment(input.comment);
    if (comment.length < COMMENT_MIN || comment.length > COMMENT_MAX) return fail(400, "Write a comment of 10 to 500 characters that says what was checked.");
    const approving = input.action === "APPROVE";
    if (run.security_flag === 1 && approving && !comment.startsWith(SECURITY_REVIEW_PREFIX)) {
      return fail(400, `A flagged invoice can only be approved with a comment that starts with "${SECURITY_REVIEW_PREFIX}".`);
    }
    if (approving && bankFlagged(db, runId) && !comment.startsWith(BANK_REVIEW_PREFIX)) {
      return fail(400, `An invoice with new or different bank details can only be approved with a comment that starts with "${BANK_REVIEW_PREFIX}".`);
    }

    const snapshot = loadSnapshot(db);
    const row = snapshot.invoices.find((i) => i.id === runId);
    if (row === undefined) return fail(409, "This run has no invoice record to review.");

    let poNumber: string | null = row.po_number;
    if (approving) {
      if (row.vendor_id === null) {
        // The PO, amounts, duplicate and bank stages never ran for an unknown vendor: approving here would skip four checks.
        return fail(409, "The vendor is not resolved, so this invoice cannot be approved here. Reject it with a comment naming the right vendor, and ask the sender for a corrected invoice.");
      }
      const chosen = (input.po_number ?? "").trim() || (row.po_inferred ? "" : (row.po_number ?? ""));
      if (chosen === "") return fail(400, "Choose the PO this invoice bills against.");
      const po = snapshot.pos.find((p) => normId(p.po_number) === normId(chosen));
      if (po === undefined || po.vendor_id !== row.vendor_id || po.status !== "open") return fail(409, "That PO is not an open PO of this vendor.");
      // This run's own row is still HOLD, so it is not counted in `remaining`.
      const remaining = remainingBalance(po, snapshot.invoices);
      const over = round2(consumedAmount(row) - remaining);
      if (over > 0 && Math.round(over * 100) > Math.round(Math.max(remaining, 0) * 100) * CONFIG.priceTolerancePct + 1e-6) {
        return fail(409, `Approving would exceed the ${formatUsd(remaining)} left on ${po.po_number} by ${formatUsd(over)}. Ask the buyer for a PO amendment first.`);
      }
      poNumber = po.po_number;
    }

    const review: RunReview = {
      action: input.action,
      comment,
      po_number: approving ? poNumber : null,
      previous_decision: "HOLD",
      created_at: now.toISOString(),
    };
    db.prepare("INSERT INTO run_reviews (id, run_id, action, comment, po_number, previous_decision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      crypto.randomUUID(),
      runId,
      review.action,
      review.comment,
      review.po_number,
      review.previous_decision,
      review.created_at,
    );
    if (approving) db.prepare("UPDATE invoices SET decision = ?, po_number = ?, po_inferred = 0 WHERE id = ?").run("APPROVE", poNumber, runId);
    else db.prepare("UPDATE invoices SET decision = ? WHERE id = ?").run("REJECT", runId);
    return { ok: true, review };
  })();
}
