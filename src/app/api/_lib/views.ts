/**
 * Read models for the GET routes: run detail, the dashboard list with its KPIs, and the procurement data.
 * Every JSON cell is parsed defensively (a corrupt cell yields null or [], never an exception) and every SQL
 * statement is parameterised. Server-only.
 */
import type { DB } from "@/lib/db";
import { maskAccount, round2 } from "@/lib/format";
import { loadSnapshot, poBalance } from "@/lib/master";
import {
  HISTORY_MODEL,
  InvoiceExtractionSchema,
  NO_SIGNALS,
  type DashboardKpis,
  type Decision,
  type InvoiceExtraction,
  type MasterResponse,
  type RunDetail,
  type RunListItem,
  type RunRow,
  type RunStatus,
  type RunStepRow,
  type RunsListResponse,
  type StepView,
} from "@/lib/types";

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** decision_reasons: a JSON array of strings; anything else (NULL on a queued run, a corrupt cell) is []. */
function parseReasons(text: string | null): string[] {
  const value = parseJson(text);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The stored extraction, re-validated: a cell that is not a valid extraction is null, so the UI never gets a wrong shape. */
function parseExtraction(text: string | null): InvoiceExtraction | null {
  const raw = parseJson(text);
  const obj = plainObject(raw);
  // Rows stored before review round B2 (extract-v1, extract-v2) have no document_signals: read them as "nothing reported".
  const value = obj !== null && !("document_signals" in obj) ? { ...obj, document_signals: NO_SIGNALS } : raw;
  const parsed = InvoiceExtractionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toStepView(row: RunStepRow): StepView {
  return {
    idx: row.idx,
    key: row.key,
    label: row.label,
    status: row.status,
    severity: row.severity,
    reason: row.reason,
    detail: plainObject(parseJson(row.detail)),
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

/** GET /api/runs/:id: the run with its steps ordered by idx (none for a pre-loaded history run), or null when unknown. */
export function loadRunDetail(db: DB, id: string): RunDetail | null {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  if (run === undefined) return null;
  const steps = db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx").all(id) as RunStepRow[];
  return {
    id: run.id,
    status: run.status,
    file_name: run.file_name,
    file_hash: run.file_hash,
    decision: run.decision,
    decision_reasons: parseReasons(run.decision_reasons),
    next_action: run.next_action,
    security_flag: run.security_flag === 1,
    extraction: parseExtraction(run.extraction),
    model: run.model,
    prompt_version: run.prompt_version,
    cost_usd: run.cost_usd,
    created_at: run.created_at,
    finished_at: run.finished_at,
    is_history: run.model === HISTORY_MODEL,
    steps: steps.map(toStepView),
  };
}

/** The `decision` query values: a decision, or "security" for every run with the security flag. */
export type RunFilter = "APPROVE" | "HOLD" | "REJECT" | "security";

interface ListRow {
  id: string;
  created_at: string;
  status: RunStatus;
  file_name: string | null;
  decision: Decision | null;
  decision_reasons: string | null;
  security_flag: number;
  cost_usd: number | null;
  model: string | null;
  extraction: string | null;
  vendor_name: string | null;
  inv_number: string | null;
  inv_total: number | null;
  inv_currency: string | null;
}

const asText = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * GET /api/runs: newest first, at most `limit` rows, optionally filtered; kpis over ALL runs. Vendor, invoice
 * number, total and currency come from the invoices row (id = run id), else from the stored extraction (a run
 * that is still working has only the latter, and a vendor that is not in the master has no name in the former).
 */
export function listRuns(db: DB, opts: { filter: RunFilter | null; limit: number }): RunsListResponse {
  const rows = db
    .prepare(
      `SELECT r.id, r.created_at, r.status, r.file_name, r.decision, r.decision_reasons, r.security_flag, r.cost_usd,
              r.model, r.extraction, v.name AS vendor_name, i.invoice_number AS inv_number, i.total AS inv_total,
              i.currency AS inv_currency
         FROM runs r
         LEFT JOIN invoices i ON i.id = r.id
         LEFT JOIN vendors v ON v.id = i.vendor_id
        WHERE (@decision IS NULL OR r.decision = @decision) AND (@security = 0 OR r.security_flag = 1)
        ORDER BY r.created_at DESC, r.rowid DESC
        LIMIT @limit`,
    )
    .all({
      decision: opts.filter === null || opts.filter === "security" ? null : opts.filter,
      security: opts.filter === "security" ? 1 : 0,
      limit: opts.limit,
    }) as ListRow[];

  const runs = rows.map((row): RunListItem => {
    const needsExtraction = row.vendor_name === null || row.inv_number === null || row.inv_total === null || row.inv_currency === null;
    const ex = needsExtraction ? plainObject(parseJson(row.extraction)) : null;
    return {
      id: row.id,
      created_at: row.created_at,
      status: row.status,
      file_name: row.file_name,
      vendor_name: row.vendor_name ?? asText(ex?.vendor_name),
      invoice_number: row.inv_number ?? asText(ex?.invoice_number),
      total: row.inv_total ?? asNumber(ex?.total),
      currency: row.inv_currency ?? asText(ex?.currency),
      decision: row.decision,
      security_flag: row.security_flag === 1,
      first_reason: parseReasons(row.decision_reasons)[0] ?? null,
      cost_usd: row.cost_usd,
      is_history: row.model === HISTORY_MODEL,
    };
  });

  const k = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(r.decision = 'APPROVE'), 0) AS approved,
              COALESCE(SUM(r.decision = 'HOLD'), 0) AS hold,
              COALESCE(SUM(r.decision = 'REJECT'), 0) AS rejected,
              COALESCE(SUM(r.security_flag = 1), 0) AS security_flags,
              COALESCE(SUM(CASE WHEN r.decision = 'APPROVE' THEN COALESCE(i.total, 0) END), 0) AS approved_value
         FROM runs r
         LEFT JOIN invoices i ON i.id = r.id`,
    )
    .get() as DashboardKpis;
  return {
    runs,
    kpis: {
      total: k.total,
      approved: k.approved,
      hold: k.hold,
      rejected: k.rejected,
      security_flags: k.security_flags,
      approved_value: round2(k.approved_value),
    },
  };
}

/** GET /api/master: vendors (bank account masked to its last 4 characters, never the raw value) and POs with their balances. */
export function loadMaster(db: DB): MasterResponse {
  const snapshot = loadSnapshot(db);
  const names = new Map(snapshot.vendors.map((v) => [v.id, v.name]));
  return {
    vendors: snapshot.vendors.map((v) => ({
      id: v.id,
      name: v.name,
      aliases: v.aliases,
      approved: v.approved,
      bank_account_masked: maskAccount(v.bank_account),
      phone_on_file: v.phone_on_file,
    })),
    purchase_orders: snapshot.pos.map((po) => {
      const balance = poBalance(po, snapshot.invoices);
      return {
        po_number: po.po_number,
        vendor_id: po.vendor_id,
        vendor_name: names.get(po.vendor_id) ?? null,
        lines: po.lines,
        subtotal: po.subtotal,
        currency: po.currency,
        status: po.status,
        invoiced: balance.invoiced,
        remaining: balance.remaining,
        approved_invoices: balance.approved_invoices,
        approved_breakdown: balance.approved_breakdown,
      };
    }),
  };
}
