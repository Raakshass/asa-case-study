/**
 * Demo master data + history loader, used by scripts/seed.ts, POST /api/reset and db.ts ensureSeeded().
 * Reads data/seed/{vendors,purchase_orders,history}.json (Phase 1 writes them; exact shapes in
 * docs/CONTRACTS.md section 3), validates them with zod plus cross-checks, then replaces ALL rows of
 * vendors, purchase_orders, runs, run_steps and invoices in one transaction (idempotent).
 * It does not touch uploaded files: the reset route deletes DATA_DIR/uploads/*.pdf itself.
 * Owner: contracts step.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "./config";
import type { DB } from "./db";
import { normId, round2 } from "./format";
import { insertInvoice } from "./master";
import { DecisionSchema, HISTORY_MODEL, PO_STATUSES, type SeedCounts } from "./types";

export const SEED_FILES = {
  vendors: "vendors.json",
  purchaseOrders: "purchase_orders.json",
  history: "history.json",
} as const;

/** decision_reasons / next_action of the synthetic run created for each history row. */
export const HISTORY_REASON = "Pre-loaded history: processed before the demo.";
export const HISTORY_NEXT_ACTION = "None: processed before the demo.";

/** Thrown for missing, unparseable or inconsistent seed data. The message is meant for humans. */
export class SeedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedDataError";
  }
}

const money = z.number().nonnegative();
const currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD");

/** data/seed/vendors.json: an array of these. */
export const SeedVendorSchema = z.strictObject({
  id: z.string().regex(/^V\d{3,}$/, 'vendor id like "V001"'),
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(200)).max(20),
  approved: z.boolean(),
  bank_account: z.string().min(1).max(60).nullable(),
  phone_on_file: z.string().min(1).max(40).nullable(),
});

export const SeedPoLineSchema = z.strictObject({
  description: z.string().min(1).max(200),
  quantity: z.number().positive(),
  unit_price: money,
  amount: money,
});

/** data/seed/purchase_orders.json: an array of these. Amounts are pre-tax. */
export const SeedPurchaseOrderSchema = z.strictObject({
  po_number: z.string().regex(/^PO-\d{4,}$/, 'PO number like "PO-1001"'),
  vendor_id: z.string().min(1),
  lines: z.array(SeedPoLineSchema).min(1).max(50),
  subtotal: money,
  currency,
  status: z.enum(PO_STATUSES),
});

/** data/seed/history.json: an array of these (invoices processed before the demo). */
export const SeedHistorySchema = z.strictObject({
  vendor_id: z.string().min(1),
  invoice_number: z.string().min(1).max(200),
  invoice_date: z.iso.date(),
  po_number: z.string().nullable(),
  subtotal: money,
  tax: money,
  total: money,
  currency,
  bank_account: z.string().min(1).max(60).nullable(),
  decision: DecisionSchema,
  /** ISO 8601 UTC timestamp; defaults to `${invoice_date}T12:00:00.000Z` */
  processed_at: z.iso.datetime().optional(),
});

export type SeedVendor = z.infer<typeof SeedVendorSchema>;
export type SeedPurchaseOrder = z.infer<typeof SeedPurchaseOrderSchema>;
export type SeedHistory = z.infer<typeof SeedHistorySchema>;

export interface SeedData {
  vendors: SeedVendor[];
  purchaseOrders: SeedPurchaseOrder[];
  history: SeedHistory[];
}

const SeedDataSchema = z.object({
  vendors: z.array(SeedVendorSchema),
  purchaseOrders: z.array(SeedPurchaseOrderSchema),
  history: z.array(SeedHistorySchema),
});

/**
 * Deterministic run id for a history row: an RFC 9562 version-8 UUID derived from sha256 of the vendor
 * and normalized invoice number, so reseeding yields the same ids and z.uuid() accepts them.
 */
export function historyRunId(vendorId: string, invoiceNumber: string): string {
  const h = crypto.createHash("sha256").update(`invoice-ap/history/${vendorId}/${normId(invoiceNumber)}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Reads and validates the three seed files. Throws SeedDataError naming the file and problem. */
export function readSeedFiles(seedDir: string = paths.seedDir): SeedData {
  const rel = path.relative(process.cwd(), seedDir) || seedDir;
  const missing = Object.values(SEED_FILES).filter((f) => !fs.existsSync(path.join(seedDir, f)));
  if (missing.length > 0) {
    throw new SeedDataError(
      `Seed data not found in ${rel}: missing ${missing.join(", ")}. Phase 1 writes these files; ` +
        "their shapes are in docs/CONTRACTS.md section 3.",
    );
  }
  const load = <T>(file: string, schema: z.ZodType<T>): T => {
    const full = path.join(seedDir, file);
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (e) {
      throw new SeedDataError(`${path.join(rel, file)} is not valid JSON: ${(e as Error).message}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new SeedDataError(`${path.join(rel, file)} does not match the contract:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  };
  const data: SeedData = {
    vendors: load(SEED_FILES.vendors, z.array(SeedVendorSchema)),
    purchaseOrders: load(SEED_FILES.purchaseOrders, z.array(SeedPurchaseOrderSchema)),
    history: load(SEED_FILES.history, z.array(SeedHistorySchema)),
  };
  const problems = validateSeedData(data);
  if (problems.length > 0) throw new SeedDataError(`Seed data in ${rel} is inconsistent:\n- ${problems.join("\n- ")}`);
  return data;
}

/** Cross-checks that zod cannot express. Returns problems; [] = consistent. */
export function validateSeedData(data: SeedData): string[] {
  const problems: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01 + 1e-9;
  const vendorIds = new Set<string>();
  for (const v of data.vendors) {
    if (vendorIds.has(v.id)) problems.push(`vendor ${v.id} appears twice`);
    vendorIds.add(v.id);
  }
  const pos = new Map<string, SeedPurchaseOrder>();
  for (const po of data.purchaseOrders) {
    if (pos.has(po.po_number)) problems.push(`${po.po_number} appears twice`);
    pos.set(po.po_number, po);
    if (!vendorIds.has(po.vendor_id)) problems.push(`${po.po_number}: unknown vendor ${po.vendor_id}`);
    po.lines.forEach((l, i) => {
      if (!near(l.quantity * l.unit_price, l.amount)) {
        problems.push(`${po.po_number} line ${i + 1}: quantity x unit_price = ${round2(l.quantity * l.unit_price)}, amount says ${l.amount}`);
      }
    });
    const sum = round2(po.lines.reduce((s, l) => s + l.amount, 0));
    if (!near(sum, po.subtotal)) problems.push(`${po.po_number}: lines sum to ${sum}, subtotal says ${po.subtotal}`);
  }
  const seen = new Set<string>();
  const consumed = new Map<string, number>();
  for (const h of data.history) {
    const key = `${h.vendor_id}/${normId(h.invoice_number)}`;
    if (seen.has(key)) problems.push(`history ${h.invoice_number}: duplicate for vendor ${h.vendor_id}`);
    seen.add(key);
    if (!vendorIds.has(h.vendor_id)) problems.push(`history ${h.invoice_number}: unknown vendor ${h.vendor_id}`);
    if (!near(h.subtotal + h.tax, h.total)) problems.push(`history ${h.invoice_number}: subtotal + tax != total`);
    if (h.po_number !== null) {
      const po = pos.get(h.po_number);
      if (!po) problems.push(`history ${h.invoice_number}: unknown PO ${h.po_number}`);
      else if (po.vendor_id !== h.vendor_id) problems.push(`history ${h.invoice_number}: ${h.po_number} belongs to ${po.vendor_id}`);
      if (h.decision === "APPROVE") consumed.set(h.po_number, (consumed.get(h.po_number) ?? 0) + h.subtotal);
    }
  }
  for (const [poNumber, used] of consumed) {
    const po = pos.get(poNumber);
    if (po && round2(used) > po.subtotal + 0.01) problems.push(`${poNumber}: approved history (${round2(used)}) exceeds the PO subtotal`);
  }
  return problems;
}

/**
 * Replaces all demo state with `data` in one transaction: clears run_steps, runs, invoices,
 * purchase_orders and vendors, then inserts vendors, POs, and per history row one synthetic `done` run
 * (model "history", no steps) plus its invoices row (id = run id).
 */
export function seedFromData(db: DB, data: SeedData): SeedCounts {
  const parsed = SeedDataSchema.safeParse(data);
  if (!parsed.success) throw new SeedDataError(`Seed data does not match the contract:\n${z.prettifyError(parsed.error)}`);
  const problems = validateSeedData(parsed.data);
  if (problems.length > 0) throw new SeedDataError(`Seed data is inconsistent:\n- ${problems.join("\n- ")}`);
  const { vendors, purchaseOrders, history } = parsed.data;

  const run = db.transaction((): SeedCounts => {
    db.exec("DELETE FROM run_steps; DELETE FROM runs; DELETE FROM invoices; DELETE FROM purchase_orders; DELETE FROM vendors;");
    const insVendor = db.prepare(
      "INSERT INTO vendors (id, name, aliases, approved, bank_account, phone_on_file) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const v of vendors) {
      insVendor.run(v.id, v.name, JSON.stringify(v.aliases), v.approved ? 1 : 0, v.bank_account, v.phone_on_file);
    }
    const insPo = db.prepare(
      "INSERT INTO purchase_orders (po_number, vendor_id, lines, subtotal, currency, status) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const po of purchaseOrders) {
      insPo.run(po.po_number, po.vendor_id, JSON.stringify(po.lines), po.subtotal, po.currency, po.status);
    }
    const insRun = db.prepare(
      `INSERT INTO runs (id, file_name, file_hash, status, decision, decision_reasons, next_action, security_flag,
         extraction, raw_model_output, model, prompt_version, cost_usd, created_at, finished_at)
       VALUES (?, NULL, NULL, 'done', ?, ?, ?, 0, NULL, NULL, ?, NULL, NULL, ?, ?)`,
    );
    for (const h of history) {
      const id = historyRunId(h.vendor_id, h.invoice_number);
      const at = h.processed_at ?? `${h.invoice_date}T12:00:00.000Z`;
      insRun.run(id, h.decision, JSON.stringify([HISTORY_REASON]), HISTORY_NEXT_ACTION, HISTORY_MODEL, at, at);
      insertInvoice(db, {
        id,
        run_id: id,
        vendor_id: h.vendor_id,
        invoice_number: h.invoice_number,
        invoice_number_norm: normId(h.invoice_number),
        invoice_date: h.invoice_date,
        po_number: h.po_number,
        po_inferred: false,
        subtotal: h.subtotal,
        tax: h.tax,
        total: h.total,
        currency: h.currency,
        bank_account: h.bank_account,
        file_hash: null,
        decision: h.decision,
        created_at: at,
      });
    }
    return { vendors: vendors.length, purchase_orders: purchaseOrders.length, invoices: history.length, runs: history.length };
  });
  return run();
}

/** readSeedFiles + seedFromData. Throws SeedDataError (nothing is changed) when the data is missing or invalid. */
export function seedDatabase(db: DB, seedDir: string = paths.seedDir): SeedCounts {
  return seedFromData(db, readSeedFiles(seedDir));
}
