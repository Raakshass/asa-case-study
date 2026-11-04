/**
 * The persistence of Automations (plan A2): plain functions over the database, each one statement or one transaction.
 * Called by the engine, the scheduler and the API routes. All SQL of the feature lives in this file, in engine.ts and
 * in seed-workflows.ts, and none of it may write the decision tables (runs, run_steps, invoices, purchase_orders,
 * vendors, run_reviews): scripts/check-static.ts check 4b fails the build if one does. Server-only.
 *
 * `secrets` holds webhook URLs and signing secrets; they are returned by nothing here except getWorkflow (the engine
 * reads the URL when a step runs) and are never logged.
 */
import { CONFIG } from "../config";
import type { DB } from "../db";

export interface WorkflowRow {
  id: string;
  name: string;
  enabled: number;
  enabled_at: string | null;
  trigger_type: string;
  graph: string;
  secrets: string;
  version: number;
  seed_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: number;
  graph: string;
  trigger_type: string;
  trigger_key: string;
  run_id: string | null;
  mode: string;
  status: string;
  error: string | null;
  vars: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ExecutionStepRow {
  execution_id: string;
  node_id: string;
  idx: number;
  type: string;
  name: string;
  status: string;
  chosen_output: string | null;
  output: string | null;
  error: string | null;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface NoteRow {
  id: string;
  run_id: string;
  execution_id: string;
  workflow_name: string;
  text: string;
  created_at: string;
}

export interface AssignmentRow {
  run_id: string;
  assignee: string;
  execution_id: string;
  workflow_name: string;
  created_at: string;
}

/* ---- workflows ---- */

export function listWorkflows(db: DB): WorkflowRow[] {
  return db.prepare("SELECT * FROM workflows ORDER BY created_at, rowid").all() as WorkflowRow[];
}

export function getWorkflow(db: DB, id: string): WorkflowRow | null {
  return (db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | undefined) ?? null;
}

export function insertWorkflow(db: DB, row: WorkflowRow): void {
  db.prepare(
    `INSERT INTO workflows (id, name, enabled, enabled_at, trigger_type, graph, secrets, version, seed_key, created_at, updated_at)
     VALUES (@id, @name, @enabled, @enabled_at, @trigger_type, @graph, @secrets, @version, @seed_key, @created_at, @updated_at)`,
  ).run(row);
}

export interface SaveInput {
  name: string;
  graph: string;
  secrets: string;
  triggerType: string;
  enabled: boolean;
  enabledAt: string | null;
  expectedVersion: number;
  now: string;
}
export type SaveResult = { ok: true; version: number } | { ok: false; reason: "not_found" | "version" };

/** Saves a new copy when `expectedVersion` is still the stored version (optimistic concurrency); the version goes up by one. */
export function saveWorkflow(db: DB, id: string, input: SaveInput): SaveResult {
  return db.transaction((): SaveResult => {
    const result = db
      .prepare(
        `UPDATE workflows SET name = ?, graph = ?, secrets = ?, trigger_type = ?, enabled = ?, enabled_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
      )
      .run(input.name, input.graph, input.secrets, input.triggerType, input.enabled ? 1 : 0, input.enabledAt, input.now, id, input.expectedVersion);
    if (result.changes === 1) return { ok: true, version: input.expectedVersion + 1 };
    return { ok: false, reason: getWorkflow(db, id) === null ? "not_found" : "version" };
  })();
}

/** Turns an automation on or off. Turning it on stamps `enabled_at`, so a schedule never fires a slot from before. Returns false when it does not exist. */
export function setEnabled(db: DB, id: string, enabled: boolean, now: string): boolean {
  const result = enabled
    ? db.prepare("UPDATE workflows SET enabled = 1, enabled_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
    : db.prepare("UPDATE workflows SET enabled = 0, updated_at = ? WHERE id = ?").run(now, id);
  return result.changes === 1;
}

/** Deletes an automation with its executions and their steps. Notes and assignments stay: they record what happened. */
export function deleteWorkflow(db: DB, id: string): boolean {
  return db.transaction((): boolean => {
    db.prepare("DELETE FROM workflow_execution_steps WHERE execution_id IN (SELECT id FROM workflow_executions WHERE workflow_id = ?)").run(id);
    db.prepare("DELETE FROM workflow_executions WHERE workflow_id = ?").run(id);
    return db.prepare("DELETE FROM workflows WHERE id = ?").run(id).changes === 1;
  })();
}

/* ---- executions ---- */

/**
 * Inserts an execution; `INSERT OR IGNORE` on UNIQUE (workflow_id, trigger_key) makes dispatch idempotent. Returns true
 * when it was inserted. Afterwards the workflow's executions beyond CONFIG.automationKeepExecutions are deleted (oldest
 * first, with their steps).
 */
export function insertExecution(db: DB, row: ExecutionRow): boolean {
  return db.transaction((): boolean => {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO workflow_executions
           (id, workflow_id, workflow_name, workflow_version, graph, trigger_type, trigger_key, run_id, mode, status, error, vars, created_at, started_at, finished_at)
         VALUES (@id, @workflow_id, @workflow_name, @workflow_version, @graph, @trigger_type, @trigger_key, @run_id, @mode, @status, @error, @vars, @created_at, @started_at, @finished_at)`,
      )
      .run(row);
    if (result.changes !== 1) return false;
    const stale = `SELECT id FROM workflow_executions WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`;
    db.prepare(`DELETE FROM workflow_execution_steps WHERE execution_id IN (${stale})`).run(row.workflow_id, CONFIG.automationKeepExecutions);
    db.prepare(`DELETE FROM workflow_executions WHERE id IN (${stale})`).run(row.workflow_id, CONFIG.automationKeepExecutions);
    return true;
  })();
}

/** queued -> running; true only for the caller that made the change. */
export function claimExecution(db: DB, id: string, now: string): boolean {
  return db.prepare("UPDATE workflow_executions SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(now, id).changes === 1;
}

export function writeStep(db: DB, step: ExecutionStepRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO workflow_execution_steps
       (execution_id, node_id, idx, type, name, status, chosen_output, output, error, attempts, started_at, finished_at)
     VALUES (@execution_id, @node_id, @idx, @type, @name, @status, @chosen_output, @output, @error, @attempts, @started_at, @finished_at)`,
  ).run(step);
}

export function finishExecution(db: DB, id: string, status: "success" | "error", error: string | null, now: string): void {
  db.prepare("UPDATE workflow_executions SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error, now, id);
}

export function getExecution(db: DB, id: string): { execution: ExecutionRow; steps: ExecutionStepRow[] } | null {
  const execution = db.prepare("SELECT * FROM workflow_executions WHERE id = ?").get(id) as ExecutionRow | undefined;
  if (execution === undefined) return null;
  const steps = db.prepare("SELECT * FROM workflow_execution_steps WHERE execution_id = ? ORDER BY idx").all(id) as ExecutionStepRow[];
  return { execution, steps };
}

export function executionsForRun(db: DB, runId: string): ExecutionRow[] {
  return db.prepare("SELECT * FROM workflow_executions WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as ExecutionRow[];
}

export function listExecutions(db: DB, workflowId: string, limit: number): ExecutionRow[] {
  return db.prepare("SELECT * FROM workflow_executions WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workflowId, limit) as ExecutionRow[];
}

export function countExecutionsSince(db: DB, iso: string): number {
  return db.prepare("SELECT COUNT(*) FROM workflow_executions WHERE created_at >= ?").pluck().get(iso) as number;
}

/** Outbound HTTP attempts since `iso`: each attempt of a webhook or chat step is one request, so retries count against the hourly cap. */
export function countSendsSince(db: DB, iso: string): number {
  return db
    .prepare("SELECT COALESCE(SUM(attempts), 0) FROM workflow_execution_steps WHERE type IN ('action.webhook', 'action.chat') AND started_at >= ?")
    .pluck()
    .get(iso) as number;
}

/* ---- what an automation changes about an invoice ---- */

export function addNote(db: DB, row: NoteRow): void {
  db.prepare("INSERT INTO run_notes (id, run_id, execution_id, workflow_name, text, created_at) VALUES (@id, @run_id, @execution_id, @workflow_name, @text, @created_at)").run(row);
}

/** The latest assignment of a run wins. */
export function assignRun(db: DB, row: AssignmentRow): void {
  db.prepare(
    `INSERT INTO run_assignments (run_id, assignee, execution_id, workflow_name, created_at)
     VALUES (@run_id, @assignee, @execution_id, @workflow_name, @created_at)
     ON CONFLICT(run_id) DO UPDATE SET assignee = excluded.assignee, execution_id = excluded.execution_id,
       workflow_name = excluded.workflow_name, created_at = excluded.created_at`,
  ).run(row);
}

export function notesForRun(db: DB, runId: string): NoteRow[] {
  return db.prepare("SELECT * FROM run_notes WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as NoteRow[];
}

export function assignmentForRun(db: DB, runId: string): AssignmentRow | null {
  return (db.prepare("SELECT * FROM run_assignments WHERE run_id = ?").get(runId) as AssignmentRow | undefined) ?? null;
}

/* ---- secrets ---- */

export interface StepSecrets {
  url?: string;
  signing_secret?: string;
}

/** The stored secrets column as an object; anything that is not the expected shape is dropped, never thrown. */
export function parseSecrets(text: string): Record<string, StepSecrets> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, StepSecrets> = {};
  for (const [nodeId, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const entry: StepSecrets = {};
    if (typeof r.url === "string" && r.url !== "") entry.url = r.url;
    if (typeof r.signing_secret === "string" && r.signing_secret !== "") entry.signing_secret = r.signing_secret;
    if (entry.url !== undefined || entry.signing_secret !== undefined) out[nodeId] = entry;
  }
  return out;
}

/** What the API may show of a webhook URL: its host and the last 4 characters of its path ("hooks.slack.com/…/a1b2"); the host alone for a short path. */
export function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "(not a valid URL)";
  }
  const path = parsed.pathname;
  return path.length < 8 ? parsed.host : `${parsed.host}/…/${path.slice(-4)}`;
}
