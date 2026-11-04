/**
 * The values an automation may use (plan 7.6): built from a finished run, from a review, and from the recent past. Only
 * the names listed in workflow-graph.ts VARIABLES exist; no bank account, no raw model output and no suspicious_content
 * is ever a value. Every text that came from an invoice is capped here (it is still untrusted: templates escape it for
 * chat and JSON-encode it for webhooks). Read-only: it never writes anything. Server-only.
 */
import type { DB } from "../db";
import { formatUsd } from "../format";
import { HISTORY_MODEL } from "../types";
import type { Vars } from "../workflow-graph";

const DECISION_TEXT: Readonly<Record<string, string>> = { APPROVE: "Approved", HOLD: "On hold", REJECT: "Rejected" };

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const asString = (v: unknown, max: number): string | null => (typeof v === "string" && v !== "" ? cap(v, max) : null);

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function reasonsOf(text: string | null): string[] {
  const value = parseJson(text);
  return Array.isArray(value) ? value.filter((r): r is string => typeof r === "string") : [];
}

const isoDay = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * The values of a finished run, or null when the run is missing, is a pre-loaded history row, or has not finished.
 * `now.date` is today's date in UTC; `workflow.name` is set by the engine for each execution.
 */
export function buildRunVars(db: DB, runId: string, baseUrl: string | null, now: Date = new Date()): Vars | null {
  const run = db
    .prepare("SELECT status, decision, decision_reasons, next_action, security_flag, file_name, extraction, finished_at, model FROM runs WHERE id = ?")
    .get(runId) as
    | { status: string; decision: string | null; decision_reasons: string | null; next_action: string | null; security_flag: number; file_name: string | null; extraction: string | null; finished_at: string | null; model: string | null }
    | undefined;
  if (run === undefined || run.model === HISTORY_MODEL) return null;
  const invoice = db.prepare("SELECT vendor_id, invoice_number, invoice_date, total, po_number, po_inferred FROM invoices WHERE id = ?").get(runId) as
    | { vendor_id: string | null; invoice_number: string | null; invoice_date: string | null; total: number | null; po_number: string | null; po_inferred: number | null }
    | undefined;
  const vendorStep = db.prepare("SELECT detail FROM run_steps WHERE run_id = ? AND key = 'vendor'").pluck().get(runId) as string | null | undefined;
  const vendorDetail = parseJson(vendorStep ?? null) as { bank_mismatch?: unknown; bank_change_notice?: unknown } | null;
  const extraction = parseJson(run.extraction) as Record<string, unknown> | null;
  const vendorMaster =
    invoice?.vendor_id != null ? (db.prepare("SELECT name FROM vendors WHERE id = ?").pluck().get(invoice.vendor_id) as string | undefined) : undefined;
  const reasons = reasonsOf(run.decision_reasons);
  const joined = reasons.join("; ");
  const total = invoice?.total ?? (typeof extraction?.total === "number" && Number.isFinite(extraction.total) ? extraction.total : null);
  return {
    "run.id": runId,
    "run.url": `${baseUrl ?? ""}/runs/${runId}`,
    "run.file_name": asString(run.file_name, 200),
    "run.decision": run.decision,
    "run.decision_text": run.decision === null ? "System error" : (DECISION_TEXT[run.decision] ?? null),
    "run.reasons": joined === "" ? null : cap(joined, 1500),
    "run.first_reason": asString(reasons[0], 500),
    "run.next_action": asString(run.next_action, 500),
    "run.security_flag": run.security_flag === 1,
    "run.bank_change": vendorDetail?.bank_mismatch === true || vendorDetail?.bank_change_notice === true,
    "run.vendor_id": invoice?.vendor_id ?? null,
    "run.vendor_name": asString(extraction?.vendor_name, 200) ?? asString(vendorMaster, 200),
    "run.invoice_number": asString(invoice?.invoice_number ?? extraction?.invoice_number, 100),
    "run.invoice_date": asString(invoice?.invoice_date ?? extraction?.invoice_date, 40),
    "run.total": total,
    "run.po_number": invoice?.po_number ?? null,
    "run.po_inferred": invoice === undefined ? null : invoice.po_inferred === 1,
    "run.finished_at": run.finished_at,
    "now.date": isoDay(now),
  };
}

/** What a person decided about a held run (the human review, B4): the outcome and the comment, or null when nobody reviewed it. */
export function buildReviewVars(db: DB, runId: string): Vars | null {
  const review = db.prepare("SELECT action, comment FROM run_reviews WHERE run_id = ?").get(runId) as { action: string; comment: string } | undefined;
  if (review === undefined) return null;
  return { "review.action": review.action, "review.comment": cap(review.comment, 500) };
}

/** The run's status, for a test: only a finished run can be tested with. */
export function runFinished(db: DB, runId: string): boolean {
  const status = db.prepare("SELECT status FROM runs WHERE id = ?").pluck().get(runId) as string | undefined;
  return status === "done" || status === "error";
}

export interface SummaryConfig {
  window_hours: number;
  decisions: readonly string[];
  max_items: number;
}

/**
 * A count, a total and a list of the recent invoices that were decided with one of the given outcomes in the last
 * `window_hours`. A hold a person has since resolved counts under its reviewed outcome, so it is no longer a hold.
 */
export function buildSummaryVars(db: DB, now: Date, config: SummaryConfig): Vars {
  const since = new Date(now.getTime() - config.window_hours * 3_600_000).toISOString();
  const marks = config.decisions.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT r.id, r.file_name, r.decision_reasons, r.extraction, i.invoice_number AS inv_number, i.total AS inv_total,
              v.name AS vendor_name
         FROM runs r
         LEFT JOIN invoices i ON i.id = r.id
         LEFT JOIN vendors v ON v.id = i.vendor_id
         LEFT JOIN run_reviews rv ON rv.run_id = r.id
        WHERE r.status = 'done' AND r.model IS NOT ? AND r.finished_at >= ? AND COALESCE(rv.action, r.decision) IN (${marks})
        ORDER BY r.finished_at DESC, r.rowid DESC`,
    )
    .all(HISTORY_MODEL, since, ...config.decisions) as {
    id: string;
    file_name: string | null;
    decision_reasons: string | null;
    extraction: string | null;
    inv_number: string | null;
    inv_total: number | null;
    vendor_name: string | null;
  }[];
  let totalValue = 0;
  const lines: string[] = [];
  for (const row of rows) {
    const extraction = parseJson(row.extraction) as Record<string, unknown> | null;
    const total = row.inv_total ?? (typeof extraction?.total === "number" && Number.isFinite(extraction.total) ? extraction.total : null);
    totalValue += total ?? 0;
    if (lines.length >= config.max_items) continue;
    const label = asString(row.inv_number ?? extraction?.invoice_number, 60) ?? asString(row.file_name, 60) ?? "unnamed file";
    const vendor = asString(extraction?.vendor_name, 80) ?? asString(row.vendor_name, 80) ?? "unknown vendor";
    const reason = asString(reasonsOf(row.decision_reasons)[0], 100) ?? "no reason recorded";
    lines.push(cap(`${label}, ${vendor}, ${total === null ? "no total" : formatUsd(total)}: ${reason}`, 200));
  }
  if (rows.length > lines.length) lines.push(`…and ${rows.length - lines.length} more`);
  return {
    "summary.count": rows.length,
    "summary.total_value": Math.round(totalValue * 100) / 100,
    "summary.list": lines.join("\n"),
    "summary.window_hours": config.window_hours,
  };
}
