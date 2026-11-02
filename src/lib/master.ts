/**
 * Procurement master data as plain values. loadSnapshot(db) reads vendors, POs and every invoices row
 * once per run; the rules then work on that Snapshot as PURE functions of
 * (extraction, normalized, snapshot, now): no fs, no db, no network, no clock.
 * Only type imports from ./db, so pure modules (rules.ts) can import this file without native modules.
 * Owner: contracts step (docs/CONTRACTS.md).
 */
import type { DB } from "./db";
import { round2 } from "./format";
import type { Decision, InvoiceRecord, PoLine, PoStatus, PurchaseOrder, SnapshotInvoice, Vendor } from "./types";

export interface Snapshot {
  vendors: Vendor[];
  pos: PurchaseOrder[];
  /** every invoices row (history + earlier runs), oldest first; never includes the run being processed */
  invoices: SnapshotInvoice[];
}

/** Remaining-balance breakdown of one PO, for evidence text and /api/master. */
export interface PoBalance {
  po_number: string;
  subtotal: number;
  invoiced: number;
  remaining: number;
  approved_invoices: string[];
}

interface VendorRow {
  id: string;
  name: string;
  aliases: string;
  approved: number;
  bank_account: string | null;
  phone_on_file: string | null;
}
interface PoRow {
  po_number: string;
  vendor_id: string;
  lines: string;
  subtotal: number;
  currency: string;
  status: string;
}
interface InvoiceRow extends Omit<InvoiceRecord, "po_inferred" | "decision"> {
  po_inferred: number | null;
  decision: string | null;
  run_had_error: number;
}

const DECISION_VALUES: readonly string[] = ["APPROVE", "HOLD", "REJECT"];

function parseJsonArray<T>(text: string, what: string): T[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error(`Corrupt ${what}: expected a JSON array`);
  return value as T[];
}

/** Reads the whole procurement state. JSON columns are parsed; 0/1 columns become booleans. */
export function loadSnapshot(db: DB): Snapshot {
  const vendors = (db.prepare("SELECT * FROM vendors ORDER BY id").all() as VendorRow[]).map(
    (r): Vendor => ({
      id: r.id,
      name: r.name,
      aliases: parseJsonArray<string>(r.aliases, `vendors.aliases (${r.id})`),
      approved: r.approved === 1,
      bank_account: r.bank_account,
      phone_on_file: r.phone_on_file,
    }),
  );
  const pos = (db.prepare("SELECT * FROM purchase_orders ORDER BY po_number").all() as PoRow[]).map(
    (r): PurchaseOrder => ({
      po_number: r.po_number,
      vendor_id: r.vendor_id,
      lines: parseJsonArray<PoLine>(r.lines, `purchase_orders.lines (${r.po_number})`),
      subtotal: r.subtotal,
      currency: r.currency,
      status: (r.status === "open" ? "open" : "closed") as PoStatus,
    }),
  );
  const invoices = (
    db
      .prepare(
        `SELECT i.*, EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id = i.run_id AND s.status = 'error') AS run_had_error
         FROM invoices i ORDER BY i.created_at, i.id`,
      )
      .all() as InvoiceRow[]
  ).map(
    (r): SnapshotInvoice => ({
      ...r,
      po_inferred: r.po_inferred === 1,
      decision: r.decision !== null && DECISION_VALUES.includes(r.decision) ? (r.decision as Decision) : null,
      run_had_error: r.run_had_error === 1,
    }),
  );
  return { vendors, pos, invoices };
}

/**
 * Amount an approved invoice consumes from its PO: subtotal (POs are pre-tax), else total when no
 * subtotal was printed (over-counts, so it fails safe), else 0.
 */
export function consumedAmount(inv: Pick<InvoiceRecord, "subtotal" | "total">): number {
  return inv.subtotal ?? inv.total ?? 0;
}

function approvedOn(po: Pick<PurchaseOrder, "po_number">, invoices: readonly InvoiceRecord[]): InvoiceRecord[] {
  return invoices
    .filter((i) => i.po_number === po.po_number && i.decision === "APPROVE")
    .sort((a, b) => (a.invoice_date ?? "").localeCompare(b.invoice_date ?? "") || a.created_at.localeCompare(b.created_at));
}

/** Sum consumed by APPROVE invoices on this PO (held and rejected invoices consume nothing). */
export function invoicedAmount(po: Pick<PurchaseOrder, "po_number">, invoices: readonly InvoiceRecord[]): number {
  return round2(approvedOn(po, invoices).reduce((sum, i) => sum + consumedAmount(i), 0));
}

/** po.subtotal - invoicedAmount (plan section 4). Can be 0 or negative. */
export function remainingBalance(po: Pick<PurchaseOrder, "po_number" | "subtotal">, invoices: readonly InvoiceRecord[]): number {
  return round2(po.subtotal - invoicedAmount(po, invoices));
}

/** Display numbers of the approving invoices, by invoice date: ["GLX-301", "GLX-302"]. */
export function approvedInvoiceNumbers(po: Pick<PurchaseOrder, "po_number">, invoices: readonly InvoiceRecord[]): string[] {
  return approvedOn(po, invoices).map((i) => i.invoice_number ?? i.id);
}

export function poBalance(po: PurchaseOrder, invoices: readonly InvoiceRecord[]): PoBalance {
  return {
    po_number: po.po_number,
    subtotal: po.subtotal,
    invoiced: invoicedAmount(po, invoices),
    remaining: remainingBalance(po, invoices),
    approved_invoices: approvedInvoiceNumbers(po, invoices),
  };
}

/** Inserts one invoices row (booleans stored as 0/1). Used by seed.ts and by the pipeline's decide stage. */
export function insertInvoice(db: DB, rec: InvoiceRecord): void {
  db.prepare(
    `INSERT INTO invoices (id, run_id, vendor_id, invoice_number, invoice_number_norm, invoice_date, po_number,
       po_inferred, subtotal, tax, total, currency, bank_account, file_hash, decision, created_at)
     VALUES (@id, @run_id, @vendor_id, @invoice_number, @invoice_number_norm, @invoice_date, @po_number,
       @po_inferred, @subtotal, @tax, @total, @currency, @bank_account, @file_hash, @decision, @created_at)`,
  ).run({
    id: rec.id,
    run_id: rec.run_id,
    vendor_id: rec.vendor_id,
    invoice_number: rec.invoice_number,
    invoice_number_norm: rec.invoice_number_norm,
    invoice_date: rec.invoice_date,
    po_number: rec.po_number,
    po_inferred: rec.po_inferred ? 1 : 0,
    subtotal: rec.subtotal,
    tax: rec.tax,
    total: rec.total,
    currency: rec.currency,
    bank_account: rec.bank_account,
    file_hash: rec.file_hash,
    decision: rec.decision,
    created_at: rec.created_at,
  });
}
