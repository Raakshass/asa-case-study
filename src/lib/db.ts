/**
 * SQLite access: schema (IMPLEMENTATION_PLAN.md section 4, verbatim), a process-wide singleton that
 * survives Next.js dev HMR, startup recovery and seed-on-empty. Server-only.
 * Owner: contracts step (docs/CONTRACTS.md).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureWorkflowsSeeded } from "./automations/seed-workflows";
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
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_at TEXT,                              -- when it was last turned on (the scheduler never fires a slot before it)
  trigger_type TEXT NOT NULL,                   -- run_finished|review_saved|schedule (copied from the graph's trigger on save)
  graph TEXT NOT NULL,                          -- JSON Graph (workflow-graph.ts); never holds secrets
  secrets TEXT NOT NULL DEFAULT '{}',           -- JSON { [nodeId]: { url?: string, signing_secret?: string } }
  version INTEGER NOT NULL DEFAULT 1,           -- +1 on every save (optimistic concurrency)
  seed_key TEXT,                                -- "route-holds" | "chat-rejections" | "daily-holds" for seeds, else NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,                  -- as it was at the start (the workflow may be renamed or deleted later)
  workflow_version INTEGER NOT NULL,
  graph TEXT NOT NULL,                          -- the graph snapshot this execution ran
  trigger_type TEXT NOT NULL,                   -- run_finished|review_saved|schedule|test
  trigger_key TEXT NOT NULL,                    -- run:<runId> | review:<runId> | schedule:<slot ISO> | test:<uuid>
  run_id TEXT,                                  -- the invoice run it is about (NULL for schedule)
  mode TEXT NOT NULL,                           -- live|test|test_send
  status TEXT NOT NULL,                         -- queued|running|success|error
  error TEXT,                                   -- fixed text, never raw exception text
  vars TEXT NOT NULL,                           -- JSON snapshot of the trigger variables
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  UNIQUE (workflow_id, trigger_key)
);
CREATE INDEX IF NOT EXISTS idx_wfx_run ON workflow_executions(run_id);
CREATE INDEX IF NOT EXISTS idx_wfx_wf ON workflow_executions(workflow_id, created_at);
CREATE TABLE IF NOT EXISTS workflow_execution_steps (
  execution_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  idx INTEGER NOT NULL,                         -- position in the topological order
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,                         -- success|error|skipped
  chosen_output TEXT,                           -- the output handle taken ("out", "true", "HOLD", ...)
  output TEXT,                                  -- JSON, at most 16 KB (truncated with "truncated": true)
  error TEXT,                                   -- fixed text
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, finished_at TEXT,
  PRIMARY KEY (execution_id, node_id)
);
CREATE TABLE IF NOT EXISTS run_notes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, execution_id TEXT NOT NULL, workflow_name TEXT NOT NULL,
  text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_run ON run_notes(run_id);
CREATE TABLE IF NOT EXISTS run_assignments (
  run_id TEXT PRIMARY KEY, assignee TEXT NOT NULL, execution_id TEXT NOT NULL, workflow_name TEXT NOT NULL,
  created_at TEXT NOT NULL                       -- the latest assignment wins (upsert)
);
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
  if (opts.recover) {
    recoverInterruptedRuns(db);
    recoverInterruptedExecutions(db);
  }
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

/**
 * Startup recovery for automations: an execution found queued or running at startup was cut off by the restart, so it
 * becomes an error with a fixed text. Its steps keep whatever they wrote; the idempotent trigger key stops a second
 * execution of the same invoice. Returns the number recovered. (The SQL is inline: db.ts imports nothing else from the
 * automations folder.)
 */
export function recoverInterruptedExecutions(db: DB, now: Date = new Date()): number {
  const result = db
    .prepare("UPDATE workflow_executions SET status = 'error', error = 'Interrupted by restart.', finished_at = ? WHERE status IN ('queued', 'running')")
    .run(now.toISOString());
  return result.changes;
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
  ensureWorkflowsSeeded(db);
  g.__invoiceApDb = { db, file };
  return db;
}
