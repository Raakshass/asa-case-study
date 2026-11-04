/**
 * Read models of Automations for the API: the list, one automation, its executions, and what ran for one invoice. In the
 * style of views.ts: every JSON cell is parsed defensively (a corrupt cell is an unreadable graph or null, never an
 * exception) and every statement is parameterised. A webhook URL or signing secret is NEVER returned: only whether one is
 * set and a hint of the URL ("hooks.slack.com/…/a1b2"). Read-only; it writes nothing. Server-only.
 */
import { ENV } from "@/lib/config";
import type { DB } from "@/lib/db";
import { maskUrl, parseSecrets, type ExecutionRow, type WorkflowRow } from "@/lib/automations/store";
import {
  NODE_SPECS,
  isTriggerType,
  summarizeStep,
  validateGraph,
  type Graph,
  type GraphProblem,
} from "@/lib/workflow-graph";
import type {
  AutomationDetail,
  AutomationListItem,
  AutomationTriggerType,
  AutomationsListResponse,
  ExecutionDetail,
  ExecutionListItem,
  ExecutionStatus,
  ExecutionStep,
  RunAutomationsResponse,
  StepSecretState,
} from "@/lib/types";

const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };
const UNREADABLE: GraphProblem[] = [{ node_id: null, message: "This automation could not be read." }];

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True when the human review feature exists (its table): a "When a hold is resolved" trigger can then start an automation. */
export function reviewTriggerAvailable(db: DB): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_reviews'").get() !== undefined;
}

/** The secret state of every step that sends (webhook, chat), from the stored secrets and the graph. */
function secretStates(row: WorkflowRow, graph: Graph): Record<string, StepSecretState> {
  const stored = parseSecrets(row.secrets);
  const out: Record<string, StepSecretState> = {};
  for (const node of graph.nodes) {
    if (!NODE_SPECS[node.type].hasUrl) continue;
    const s = stored[node.id];
    out[node.id] = { has_url: s?.url !== undefined, url_hint: s?.url === undefined ? null : maskUrl(s.url), has_signing_secret: s?.signing_secret !== undefined };
  }
  return out;
}

/** The graph of a row, with the problems found in it (unreadable JSON is one problem and an empty graph). */
export function graphAndProblems(row: WorkflowRow, reviewTrigger: boolean): { graph: Graph; problems: GraphProblem[]; states: Record<string, StepSecretState> } {
  const checked = validateGraph(parseJson(row.graph), { reviewTrigger });
  if (checked.graph === null) return { graph: EMPTY_GRAPH, problems: UNREADABLE, states: {} };
  const states = secretStates(row, checked.graph);
  const withSecrets = validateGraph(checked.graph, { reviewTrigger, secrets: Object.fromEntries(Object.entries(states).map(([id, s]) => [id, { has_url: s.has_url }])) });
  return { graph: checked.graph, problems: withSecrets.problems, states };
}

const asTrigger = (value: string): AutomationTriggerType => (value === "review_saved" || value === "schedule" ? value : "run_finished");

/** GET /api/automations. */
export function listAutomations(db: DB, now: Date = new Date()): AutomationsListResponse {
  const rows = db.prepare("SELECT * FROM workflows ORDER BY created_at, rowid").all() as WorkflowRow[];
  const reviewTrigger = reviewTriggerAvailable(db);
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const automations = rows.map((row): AutomationListItem => {
    const { graph, problems } = graphAndProblems(row, reviewTrigger);
    const trigger = graph.nodes.find((n) => isTriggerType(n.type));
    const last = db.prepare("SELECT status, created_at FROM workflow_executions WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(row.id) as
      | { status: ExecutionStatus; created_at: string }
      | undefined;
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      trigger_type: asTrigger(row.trigger_type),
      trigger_summary: trigger === undefined ? "No starting step" : summarizeStep(trigger),
      step_count: graph.nodes.length,
      updated_at: row.updated_at,
      last_execution: last ?? null,
      executions_24h: db.prepare("SELECT COUNT(*) FROM workflow_executions WHERE workflow_id = ? AND created_at >= ?").pluck().get(row.id, since) as number,
      problem_count: problems.length,
      seed_key: row.seed_key,
    };
  });
  return { automations, sending_enabled: ENV.automationAllowedHosts.length > 0, automations_enabled: ENV.automationsEnabled };
}

/** GET /api/automations/:id, or null. */
export function loadAutomation(db: DB, id: string): AutomationDetail | null {
  const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | undefined;
  if (row === undefined) return null;
  const reviewTrigger = reviewTriggerAvailable(db);
  const { graph, problems, states } = graphAndProblems(row, reviewTrigger);
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    version: row.version,
    graph,
    secrets: states,
    problems,
    updated_at: row.updated_at,
    sending_enabled: ENV.automationAllowedHosts.length > 0,
    allowed_hosts: ENV.automationAllowedHosts,
    review_trigger_available: reviewTrigger,
  };
}

/** "<invoice number or file name>, <vendor name>" for the run an execution is about. */
function runLabel(db: DB, runId: string | null): string | null {
  if (runId === null) return null;
  const row = db
    .prepare(
      `SELECT r.file_name, r.extraction, i.invoice_number, v.name AS vendor_name
         FROM runs r LEFT JOIN invoices i ON i.id = r.id LEFT JOIN vendors v ON v.id = i.vendor_id WHERE r.id = ?`,
    )
    .get(runId) as { file_name: string | null; extraction: string | null; invoice_number: string | null; vendor_name: string | null } | undefined;
  if (row === undefined) return null;
  const ex = parseJson(row.extraction) as { invoice_number?: unknown; vendor_name?: unknown } | null;
  const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v.slice(0, 80) : null);
  const number = text(row.invoice_number) ?? text(ex?.invoice_number) ?? text(row.file_name) ?? "unnamed file";
  const vendor = text(ex?.vendor_name) ?? text(row.vendor_name);
  return vendor === null ? number : `${number}, ${vendor}`;
}

function toListItem(db: DB, e: ExecutionRow): ExecutionListItem {
  const known = ["run_finished", "review_saved", "schedule", "test"] as const;
  const modes = ["live", "test", "test_send"] as const;
  return {
    id: e.id,
    trigger_type: known.find((k) => k === e.trigger_type) ?? "test",
    mode: modes.find((m) => m === e.mode) ?? "live",
    status: (["queued", "running", "success", "error"] as const).find((s) => s === e.status) ?? "error",
    error: e.error,
    run_id: e.run_id,
    run_label: runLabel(db, e.run_id),
    created_at: e.created_at,
    finished_at: e.finished_at,
  };
}

/** GET /api/automations/:id/executions: newest first, or null when the automation does not exist. */
export function loadExecutions(db: DB, workflowId: string, limit: number): ExecutionListItem[] | null {
  if (db.prepare("SELECT 1 FROM workflows WHERE id = ?").get(workflowId) === undefined) return null;
  const rows = db.prepare("SELECT * FROM workflow_executions WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workflowId, limit) as ExecutionRow[];
  return rows.map((e) => toListItem(db, e));
}

/** GET /api/automations/executions/:id, or null. The graph is the snapshot the execution ran. */
export function loadExecutionDetail(db: DB, id: string): ExecutionDetail | null {
  const e = db.prepare("SELECT * FROM workflow_executions WHERE id = ?").get(id) as ExecutionRow | undefined;
  if (e === undefined) return null;
  const checked = validateGraph(parseJson(e.graph));
  const steps = (db.prepare("SELECT * FROM workflow_execution_steps WHERE execution_id = ? ORDER BY idx").all(id) as {
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
  }[]).map(
    (s): ExecutionStep => ({
      node_id: s.node_id,
      idx: s.idx,
      type: s.type,
      name: s.name,
      status: s.status === "success" || s.status === "skipped" ? s.status : "error",
      chosen_output: s.chosen_output,
      output: parseJson(s.output),
      error: s.error,
      attempts: s.attempts,
      started_at: s.started_at,
      finished_at: s.finished_at,
    }),
  );
  return { ...toListItem(db, e), workflow_id: e.workflow_id, workflow_name: e.workflow_name, graph: checked.graph ?? EMPTY_GRAPH, steps };
}

/** GET /api/runs/:id/automations, or null when the run does not exist. */
export function loadRunAutomations(db: DB, runId: string): RunAutomationsResponse | null {
  if (db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId) === undefined) return null;
  const executions = (db.prepare("SELECT * FROM workflow_executions WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as ExecutionRow[]).map((e) => ({
    ...toListItem(db, e),
    workflow_id: e.workflow_id,
    workflow_name: e.workflow_name,
  }));
  const notes = db.prepare("SELECT text, workflow_name, created_at FROM run_notes WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as { text: string; workflow_name: string; created_at: string }[];
  const assignment = (db.prepare("SELECT assignee, workflow_name, created_at FROM run_assignments WHERE run_id = ?").get(runId) as { assignee: string; workflow_name: string; created_at: string } | undefined) ?? null;
  return { executions, notes, assignment, pending: executions.filter((e) => e.status === "queued" || e.status === "running").length };
}
