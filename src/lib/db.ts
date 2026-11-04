/**
 * SQLite access: schema (IMPLEMENTATION_PLAN.md section 4, verbatim), a process-wide singleton that
 * survives Next.js dev HMR, startup recovery and seed-on-empty. Server-only.
 * Owner: contracts step (docs/CONTRACTS.md).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { paths } from "./config";
import { SeedDataError, seedDatabase } from "./seed";
import type { SeedCounts } from "./types";

export type DB = Database.Database;

/** Plan section 4, verbatim. Every statement is idempotent (IF NOT EXISTS). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
  approved INTEGER NOT NULL, bank_account TEXT, phone_on_file TEXT
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  po_number TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, lines TEXT NOT NULL,
  subtotal REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, file_name TEXT, file_hash TEXT,
  status TEXT NOT NULL,                       -- queued|running|done|error
  decision TEXT, decision_reasons TEXT,       -- JSON string[]
  next_action TEXT, security_flag INTEGER NOT NULL DEFAULT 0,
  extraction TEXT,                            -- validated JSON
  raw_model_output TEXT,                      -- as returned, for audit
  model TEXT, prompt_version TEXT, cost_usd REAL,
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS run_steps (
  run_id TEXT NOT NULL, idx INTEGER NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL,
  status TEXT NOT NULL,                       -- pending|running|pass|warn|fail|skipped|error
  severity TEXT,                              -- reject|hold|info
  reason TEXT, detail TEXT,                   -- detail = JSON evidence
  started_at TEXT, finished_at TEXT, PRIMARY KEY (run_id, idx)
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, run_id TEXT, vendor_id TEXT, invoice_number TEXT,
  invoice_number_norm TEXT, invoice_date TEXT, po_number TEXT, po_inferred INTEGER DEFAULT 0,
  subtotal REAL, tax REAL, total REAL, currency TEXT, bank_account TEXT, file_hash TEXT,
  decision TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_vendor_num ON invoices(vendor_id, invoice_number_norm);
CREATE INDEX IF NOT EXISTS idx_inv_hash ON invoices(file_hash);
`;

/**
 * Tables added after the plan's section 4 (review round B4 onward). SCHEMA_SQL stays the plan's section 4 verbatim
 * (scripts/checks/contracts.ts asserts it), so every later table lives here. Idempotent, like SCHEMA_SQL.
 */
export const EXTRA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_reviews (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,                       -- APPROVE|REJECT
  comment TEXT NOT NULL,
  po_number TEXT,                             -- the PO the reviewer confirmed (APPROVE only)
  previous_decision TEXT NOT NULL,            -- always HOLD today
  created_at TEXT NOT NULL
);
`;

/** runs.decision_reasons of a run found queued/running at startup (plan section 4). */
export const INTERRUPTED_REASON = "Interrupted by restart, please re-run";
export const INTERRUPTED_NEXT_ACTION = "Re-run this invoice.";

export interface OpenDbOptions {
  /** Run recoverInterruptedRuns() after opening. Only getDb() (process startup) should pass true. */
  recover?: boolean;
}

/**
 * Opens (creating if needed) a database and applies the schema. ":memory:" works (tests).
 * File databases get WAL mode; the parent directory is created.
 */
export function openDb(file: string, opts: OpenDbOptions = {}): DB {
  const inMemory = file === ":memory:";
  if (!inMemory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (!inMemory) db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA_SQL);
  db.exec(EXTRA_SCHEMA_SQL);
  if (opts.recover) recoverInterruptedRuns(db);
  return db;
}

/**
 * Startup recovery (plan section 4): every queued/running run becomes status "error" with
 * decision_reasons [INTERRUPTED_REASON] and decision left NULL; its running steps become "error" and its
 * pending steps "skipped". No invoices row is written (the run never decided), so a re-run is not
 * treated as a duplicate. Returns the number of runs recovered.
 */
export function recoverInterruptedRuns(db: DB, now: Date = new Date()): number {
  const ts = now.toISOString();
  const recover = db.transaction((): number => {
    const ids = db.prepare("SELECT id FROM runs WHERE status IN ('queued', 'running')").pluck().all() as string[];
    const markRun = db.prepare(
      "UPDATE runs SET status = 'error', decision_reasons = ?, next_action = ?, finished_at = ? WHERE id = ?",
    );
    const markRunning = db.prepare(
      "UPDATE run_steps SET status = 'error', reason = ?, finished_at = ? WHERE run_id = ? AND status = 'running'",
    );
    const markPending = db.prepare(
      "UPDATE run_steps SET status = 'skipped', reason = ? WHERE run_id = ? AND status = 'pending'",
    );
    for (const id of ids) {
      markRun.run(JSON.stringify([INTERRUPTED_REASON]), INTERRUPTED_NEXT_ACTION, ts, id);
      markRunning.run(INTERRUPTED_REASON, ts, id);
      markPending.run("Not run (interrupted by restart)", id);
    }
    return ids.length;
  });
  return recover();
}

export interface EnsureSeededResult {
  seeded: boolean;
  counts?: SeedCounts;
  /** set when the vendors table was empty but the seed data is missing or invalid */
  error?: string;
}

/**
 * Seeds when the vendors table is empty (first boot, fresh volume). Missing or invalid seed data is
 * logged and returned, not thrown, so the app still starts. Other errors propagate.
 */
export function ensureSeeded(db: DB, seedDir: string = paths.seedDir): EnsureSeededResult {
  const vendors = db.prepare("SELECT COUNT(*) FROM vendors").pluck().get() as number;
  if (vendors > 0) return { seeded: false };
  try {
    return { seeded: true, counts: seedDatabase(db, seedDir) };
  } catch (e) {
    if (e instanceof SeedDataError) {
      console.warn(`[db] vendors table is empty and seeding failed: ${e.message}`);
      return { seeded: false, error: e.message };
    }
    throw e;
  }
}

type GlobalWithDb = typeof globalThis & { __invoiceApDb?: { db: DB; file: string } };

/**
 * The app's database (DATA_DIR/app.db). First call in a process: open + schema + startup recovery +
 * ensureSeeded. Cached on globalThis so Next.js dev HMR and the server/route module layers share one
 * handle. Call it lazily inside handlers (never at module top level), and mark DB-reading pages/routes
 * `export const dynamic = "force-dynamic"` so `next build` never opens the database.
 */
export function getDb(): DB {
  const g = globalThis as GlobalWithDb;
  const file = paths.dbFile;
  if (g.__invoiceApDb?.file === file) return g.__invoiceApDb.db;
  g.__invoiceApDb?.db.close();
  const db = openDb(file, { recover: true });
  ensureSeeded(db);
  g.__invoiceApDb = { db, file };
  return db;
}
