/**
 * The Automations engine (plan A4): after the agent has decided an invoice, run the enabled automations that listen for
 * it, one execution each, and record what every step did. Called by the pipeline's finish hook (dispatchRunFinished), by
 * the scheduler, and by the API routes for a test. It only ever writes its own tables (workflows, executions and their
 * steps, run_notes, run_assignments): automations route what was decided, they never decide, so nothing here may touch
 * runs, run_steps, invoices, purchase_orders, vendors or run_reviews (scripts/check-static.ts check 4b, and the
 * "automations invariant" test, enforce it).
 *
 * Executions run on their own serial chain, separate from the pipeline's, so an automation waiting on a slow webhook never
 * delays the next invoice. A reset pauses the chain and bumps a generation: an execution that was running when the reset
 * happened stops without writing (its rows are gone anyway). No expressions and no code: a step is one of a fixed list
 * (workflow-graph.ts), and a template is a fixed-list substitution. Server-only.
 */
import crypto from "node:crypto";
import { CONFIG, ENV } from "../config";
import { getDb, type DB } from "../db";
import { loadSnapshot, poBalance } from "../master";
import {
  CONFIG_SCHEMAS,
  GraphSchema,
  evaluateCondition,
  isTriggerType,
  renderTemplate,
  topoOrder,
  validateGraph,
  type Condition,
  type Graph,
  type GraphNode,
  type Vars,
} from "../workflow-graph";
import { sendHttps, type Sender } from "./send";
import {
  addNote,
  assignRun,
  claimExecution,
  countExecutionsSince,
  countSendsSince,
  finishExecution,
  getExecution,
  getWorkflow,
  insertExecution,
  parseSecrets,
  writeStep,
  type ExecutionRow,
  type WorkflowRow,
} from "./store";
import { buildReviewVars, buildRunVars, buildSummaryVars, runFinished } from "./vars";

export interface AutomationDeps {
  db: DB;
  now: () => Date;
  send: Sender;
  allowedHosts: readonly string[];
  baseUrl: string | null;
  /** tests pass an instant one */
  sleep: (ms: number) => Promise<void>;
  /** the human review feature (B4) is present: a "When a hold is resolved" trigger can start an automation */
  reviewTrigger: boolean;
}

/** Production wiring: the real clock, sendHttps, the environment's hosts and base URL, setTimeout. */
export function defaultAutomationDeps(db?: DB): AutomationDeps {
  const handle = db ?? getDb();
  return {
    db: handle,
    now: () => new Date(),
    send: sendHttps,
    allowedHosts: ENV.automationAllowedHosts,
    baseUrl: ENV.appBaseUrl,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    reviewTrigger: handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_reviews'").get() !== undefined,
  };
}

/* ------------------------------------------------------------------------------------------------
 * The chain, the generation and the pause
 * ---------------------------------------------------------------------------------------------- */

interface QueueState {
  /** settles when everything appended so far has finished; never rejects */
  tail: Promise<void>;
}
interface ControlState {
  generation: number;
  paused: boolean;
}
type GlobalWithAutomation = typeof globalThis & { __invoiceApAutomationQueue?: QueueState; __invoiceApAutomation?: ControlState };

/** One chain per process on globalThis (Next duplicates modules per route bundle), like the pipeline's. */
function queue(): QueueState {
  const g = globalThis as GlobalWithAutomation;
  g.__invoiceApAutomationQueue ??= { tail: Promise.resolve() };
  return g.__invoiceApAutomationQueue;
}
function control(): ControlState {
  const g = globalThis as GlobalWithAutomation;
  g.__invoiceApAutomation ??= { generation: 0, paused: false };
  return g.__invoiceApAutomation;
}

/** Appends `task` after everything queued before it. The chain survives a rejecting task; the caller does not see it. */
export function chainAutomation(task: () => Promise<void>): void {
  const q = queue();
  q.tail = q.tail.then(task).then(
    () => undefined,
    (e: unknown) => {
      logLine({ event: "automation_execution", status: "error", error: errorName(e) });
    },
  );
}

/** Resolves when every execution queued so far has finished, including ones queued while it waits. Never rejects. */
export async function automationsIdle(): Promise<void> {
  const q = queue();
  for (;;) {
    const tail = q.tail;
    await tail.catch(() => undefined);
    if (q.tail === tail) return;
  }
}

/** A reset deleted the tables an execution writes to: any execution that started before this stops without writing. */
export function bumpAutomationGeneration(): void {
  control().generation += 1;
}

/**
 * Pauses dispatch (nothing is recorded or queued while paused) and waits until the running executions end or
 * `maxWaitMs` passes. Returns `resume`. The reset route wraps its work in it.
 */
export async function pauseAutomations(maxWaitMs: number): Promise<() => void> {
  const c = control();
  c.paused = true;
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxWaitMs);
  });
  try {
    await Promise.race([automationsIdle(), waited]);
  } finally {
    clearTimeout(timer);
  }
  return () => {
    c.paused = false;
  };
}

function logLine(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}
/** The error's name only, in a safe charset: its message could quote an invoice. */
function errorName(e: unknown): string {
  const raw = e instanceof Error ? e.name : "Error";
  return raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || "Error";
}

/* ------------------------------------------------------------------------------------------------
 * Dispatch
 * ---------------------------------------------------------------------------------------------- */

const HOUR_MS = 3_600_000;
const OVER_CAP = (): string => `Skipped: the limit of ${CONFIG.automationMaxExecutionsPerHour} automation runs an hour was reached.`;

interface Candidate {
  row: WorkflowRow;
  graph: Graph;
}

/** The enabled automations of one trigger type, with their graphs parsed (one that cannot be read is skipped). */
function enabledOf(db: DB, triggerType: string): Candidate[] {
  const rows = db.prepare("SELECT * FROM workflows WHERE enabled = 1 AND trigger_type = ? ORDER BY created_at, rowid").all(triggerType) as WorkflowRow[];
  const out: Candidate[] = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.graph);
    } catch {
      continue;
    }
    const graph = GraphSchema.safeParse(raw);
    if (graph.success) out.push({ row, graph: graph.data });
  }
  return out;
}

/** Queues one execution of `row` (or records it as skipped when the hourly cap is full). Returns whether a row was inserted. */
function queueExecution(
  deps: AutomationDeps,
  row: WorkflowRow,
  input: { triggerType: ExecutionRow["trigger_type"]; triggerKey: string; runId: string | null; mode: ExecutionRow["mode"]; vars: Vars },
): { inserted: boolean; id: string; capped: boolean } {
  const now = deps.now();
  const id = crypto.randomUUID();
  const capped = countExecutionsSince(deps.db, new Date(now.getTime() - HOUR_MS).toISOString()) >= CONFIG.automationMaxExecutionsPerHour;
  const stamp = now.toISOString();
  const inserted = insertExecution(deps.db, {
    id,
    workflow_id: row.id,
    workflow_name: row.name,
    workflow_version: row.version,
    graph: row.graph,
    trigger_type: input.triggerType,
    trigger_key: input.triggerKey,
    run_id: input.runId,
    mode: input.mode,
    status: capped ? "error" : "queued",
    error: capped ? OVER_CAP() : null,
    vars: JSON.stringify({ ...input.vars, "workflow.name": row.name }),
    created_at: stamp,
    started_at: null,
    finished_at: capped ? stamp : null,
  });
  if (inserted && !capped) chainAutomation(() => executeWorkflow(deps, id));
  return { inserted, id, capped };
}

/** The settings of a graph's starting step, or null. */
function triggerConfig(graph: Graph, type: string): Record<string, unknown> | null {
  const node = graph.nodes.find((n) => n.type === type);
  if (node === undefined) return null;
  const parsed = (CONFIG_SCHEMAS[node.type] as { safeParse(v: unknown): { success: boolean; data?: unknown } }).safeParse(node.config);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

/**
 * After a run finished (done or error): start every enabled "When an invoice is decided" automation whose outcome filter
 * matches it. Never throws and never waits for an execution. Each invoice starts each automation at most once (the
 * execution's trigger key is unique).
 */
export function dispatchRunFinished(deps: AutomationDeps, runId: string): void {
  try {
    if (!ENV.automationsEnabled || control().paused) return;
    const vars = buildRunVars(deps.db, runId, deps.baseUrl, deps.now());
    if (vars === null) return;
    for (const { row, graph } of enabledOf(deps.db, "run_finished")) {
      const config = triggerConfig(graph, "trigger.run_finished");
      if (config === null) continue;
      const decision = vars["run.decision"];
      const matches = typeof decision === "string" ? (config.decisions as string[]).includes(decision) : config.include_errors === true;
      if (!matches) continue;
      queueExecution(deps, row, { triggerType: "run_finished", triggerKey: `run:${runId}`, runId, mode: "live", vars });
    }
  } catch (e) {
    logLine({ event: "automation_dispatch", status: "error", error: errorName(e) });
  }
}

/**
 * After a person resolved a hold (the review route calls this after a 200): start every enabled "When a hold is resolved"
 * automation whose outcome filter lists the review's action. Never throws and never waits. Keyed `review:<runId>`, so a
 * run starts each automation at most once (a run can be reviewed only once anyway).
 */
export function dispatchReviewSaved(deps: AutomationDeps, runId: string): void {
  try {
    if (!ENV.automationsEnabled || control().paused) return;
    const base = buildRunVars(deps.db, runId, deps.baseUrl, deps.now());
    const review = buildReviewVars(deps.db, runId);
    if (base === null || review === null) return;
    const vars: Vars = { ...base, ...review };
    for (const { row, graph } of enabledOf(deps.db, "review_saved")) {
      const config = triggerConfig(graph, "trigger.review_saved");
      if (config === null || !(config.actions as string[]).includes(String(review["review.action"]))) continue;
      queueExecution(deps, row, { triggerType: "review_saved", triggerKey: `review:${runId}`, runId, mode: "live", vars });
    }
  } catch (e) {
    logLine({ event: "automation_dispatch", status: "error", error: errorName(e) });
  }
}

export type TestStart = { ok: true; executionId: string } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Starts a test execution of one automation (from the editor): it ignores `enabled` and the starting step's outcome
 * filter, counts toward the hourly cap, and writes no note or assignment. `send` false shows a preview of what a webhook
 * or chat step would send; true really sends (still only to an allowed host).
 */
export function startTestExecution(deps: AutomationDeps, workflowId: string, runId: string | null, send: boolean): TestStart {
  const row = getWorkflow(deps.db, workflowId);
  if (row === null) return { ok: false, status: 404, error: "Automation not found." };
  let raw: unknown;
  try {
    raw = JSON.parse(row.graph);
  } catch {
    raw = null;
  }
  // Without the `secrets` option: a missing webhook URL does not block a test (a test that does not send shows a preview).
  const checked = validateGraph(raw, { reviewTrigger: deps.reviewTrigger });
  if (checked.graph === null || checked.problems.length > 0) return { ok: false, status: 409, error: "Fix the problems listed before testing." };
  const trigger = checked.graph.nodes.find((n) => isTriggerType(n.type)) as GraphNode;
  let vars: Vars = { "now.date": deps.now().toISOString().slice(0, 10) };
  let usedRun: string | null = null;
  if (trigger.type !== "trigger.schedule") {
    const base = runId === null || !runFinished(deps.db, runId) ? null : buildRunVars(deps.db, runId, deps.baseUrl, deps.now());
    if (runId === null || base === null) return { ok: false, status: 400, error: "Choose a finished invoice to test with." };
    vars = base;
    usedRun = runId;
    if (trigger.type === "trigger.review_saved") {
      const review = buildReviewVars(deps.db, runId);
      if (review === null) return { ok: false, status: 400, error: "That invoice has not been reviewed yet; choose one that has." };
      vars = { ...vars, ...review };
    }
  }
  const cap = countExecutionsSince(deps.db, new Date(deps.now().getTime() - HOUR_MS).toISOString()) >= CONFIG.automationMaxExecutionsPerHour;
  if (cap) return { ok: false, status: 409, error: `The limit of ${CONFIG.automationMaxExecutionsPerHour} automation runs an hour was reached. Try again later.` };
  const out = queueExecution(deps, row, { triggerType: "test", triggerKey: `test:${crypto.randomUUID()}`, runId: usedRun, mode: send ? "test_send" : "test", vars });
  return { ok: true, executionId: out.id };
}

/* ------------------------------------------------------------------------------------------------
 * Execution
 * ---------------------------------------------------------------------------------------------- */

type NodeResult =
  | { status: "success"; chosen: string; output: unknown; vars?: Vars; attempts?: number }
  | { status: "error"; error: string; output?: unknown; attempts?: number };

/** Thrown inside an execution when a reset happened meanwhile: stop quietly, nothing to write. */
class Superseded extends Error {}

const MAX_OUTPUT_CHARS = 16_384;
function outputJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(value);
  return text.length <= MAX_OUTPUT_CHARS ? text : JSON.stringify({ truncated: true, text: text.slice(0, MAX_OUTPUT_CHARS - 40) });
}

const asText = (v: unknown, max = 200): string | null => (v === undefined || v === null ? null : String(v).slice(0, max));

const EVENT_NAMES: Readonly<Record<string, string>> = { run_finished: "invoice.decided", review_saved: "invoice.reviewed", schedule: "schedule", test: "test" };

/** Runs one queued execution to the end. Never throws. */
export async function executeWorkflow(deps: AutomationDeps, executionId: string): Promise<void> {
  const { db } = deps;
  const gen = control().generation;
  const alive = (): void => {
    if (control().generation !== gen) throw new Superseded();
  };
  try {
    alive();
    if (!claimExecution(db, executionId, deps.now().toISOString())) return;
    const found = getExecution(db, executionId);
    if (found === null) return;
    const row = found.execution;

    let raw: unknown;
    try {
      raw = JSON.parse(row.graph);
    } catch {
      raw = null;
    }
    const checked = validateGraph(raw, { reviewTrigger: deps.reviewTrigger });
    const order = checked.graph === null ? null : topoOrder(checked.graph);
    if (checked.graph === null || checked.problems.length > 0 || order === null) {
      alive();
      finishExecution(db, executionId, "error", "The automation has problems; open it to see them.", deps.now().toISOString());
      return;
    }
    const graph = checked.graph;
    let vars: Vars;
    try {
      vars = { ...(JSON.parse(row.vars) as Vars), "workflow.name": row.workflow_name };
    } catch {
      vars = { "workflow.name": row.workflow_name };
    }
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const taken = new Set<string>();
    let failed = false;

    for (const [idx, nodeId] of order.entries()) {
      const node = nodes.get(nodeId) as GraphNode;
      const incoming = graph.edges.filter((e) => e.target === nodeId);
      const reached = isTriggerType(node.type) || incoming.some((e) => taken.has(e.id));
      alive();
      if (!reached) {
        writeStep(db, { execution_id: executionId, node_id: nodeId, idx, type: node.type, name: node.name, status: "skipped", chosen_output: null, output: null, error: null, attempts: 0, started_at: null, finished_at: null });
        continue;
      }
      const started = deps.now().toISOString();
      let result: NodeResult;
      try {
        result = await runNode(deps, row, node, vars, alive);
      } catch (e) {
        if (e instanceof Superseded) throw e;
        logLine({ event: "automation_step", status: "error", type: node.type, error: errorName(e) });
        result = { status: "error", error: "This step failed unexpectedly." };
      }
      alive();
      const finished = deps.now().toISOString();
      if (result.status === "success") {
        writeStep(db, { execution_id: executionId, node_id: nodeId, idx, type: node.type, name: node.name, status: "success", chosen_output: result.chosen, output: outputJson(result.output), error: null, attempts: result.attempts ?? 0, started_at: started, finished_at: finished });
        for (const e of graph.edges) if (e.source === nodeId && e.sourceHandle === result.chosen) taken.add(e.id);
        if (result.vars !== undefined) vars = { ...vars, ...result.vars };
      } else {
        failed = true;
        writeStep(db, { execution_id: executionId, node_id: nodeId, idx, type: node.type, name: node.name, status: "error", chosen_output: null, output: outputJson(result.output), error: result.error, attempts: result.attempts ?? 0, started_at: started, finished_at: finished });
      }
    }
    alive();
    finishExecution(db, executionId, failed ? "error" : "success", failed ? "One or more steps failed; see the steps." : null, deps.now().toISOString());
  } catch (e) {
    if (e instanceof Superseded) return;
    logLine({ event: "automation_execution", status: "error", error: errorName(e) });
    try {
      if (control().generation === gen) finishExecution(db, executionId, "error", "The automation stopped unexpectedly.", deps.now().toISOString());
    } catch {
      // the database itself is unusable: nothing more to record
    }
  }
}

/** One step. `alive` is checked before anything is written. */
async function runNode(deps: AutomationDeps, exec: ExecutionRow, node: GraphNode, vars: Vars, alive: () => void): Promise<NodeResult> {
  const { db } = deps;
  const config = (CONFIG_SCHEMAS[node.type] as { parse(v: unknown): unknown }).parse(node.config) as Record<string, unknown>;
  const live = exec.mode === "live";
  switch (node.type) {
    case "trigger.run_finished":
    case "trigger.review_saved":
    case "trigger.schedule":
      return { status: "success", chosen: "out", output: {} };

    case "logic.if": {
      const conditions = config.conditions as Condition[];
      const results = conditions.map((c) => evaluateCondition(c, vars));
      const result = config.combine === "all" ? results.every(Boolean) : results.some(Boolean);
      const checked = conditions.map((c) => ({ field: c.field, op: c.op, value: c.value, actual: asText((vars as Record<string, unknown>)[c.field]) }));
      return { status: "success", chosen: result ? "true" : "false", output: { result, checked } };
    }

    case "logic.switch_decision": {
      const decision = vars["run.decision"];
      const chosen = typeof decision === "string" && decision !== "" ? decision : "ERROR";
      return { status: "success", chosen, output: { decision: chosen } };
    }

    case "data.vendor": {
      const id = vars["run.vendor_id"];
      const vendor = typeof id === "string" ? (db.prepare("SELECT name, approved, phone_on_file FROM vendors WHERE id = ?").get(id) as { name: string; approved: number; phone_on_file: string | null } | undefined) : undefined;
      if (vendor === undefined) return { status: "error", error: "This invoice's vendor is not in the vendor master." };
      const out: Vars = { "vendor.name": vendor.name, "vendor.approved": vendor.approved === 1, "vendor.phone_on_file": vendor.phone_on_file };
      return { status: "success", chosen: "out", output: { name: vendor.name, approved: vendor.approved === 1 }, vars: out };
    }

    case "data.po_balance": {
      const number = vars["run.po_number"];
      if (typeof number !== "string" || number === "") return { status: "error", error: "This invoice has no PO." };
      const snapshot = loadSnapshot(db);
      const po = snapshot.pos.find((p) => p.po_number === number);
      if (po === undefined) return { status: "error", error: "The PO is not in the procurement data." };
      const balance = poBalance(po, snapshot.invoices);
      const out: Vars = { "po.number": po.po_number, "po.subtotal": po.subtotal, "po.remaining": balance.remaining, "po.status": po.status };
      return { status: "success", chosen: "out", output: { number: po.po_number, subtotal: po.subtotal, remaining: balance.remaining, status: po.status }, vars: out };
    }

    case "data.summarize": {
      const summary = buildSummaryVars(db, deps.now(), { window_hours: config.window_hours as number, decisions: config.decisions as string[], max_items: config.max_items as number });
      return { status: "success", chosen: "out", output: { count: summary["summary.count"], total_value: summary["summary.total_value"] }, vars: summary };
    }

    case "action.note": {
      const text = renderTemplate(config.text as string, vars, "none").text.trim().slice(0, 1000);
      if (text === "") return { status: "error", error: "The note came out empty." };
      if (!live) return { status: "success", chosen: "out", output: { would_write: text } };
      const runId = exec.run_id;
      if (runId === null) return { status: "error", error: "This step needs an invoice." };
      alive();
      addNote(db, { id: crypto.randomUUID(), run_id: runId, execution_id: exec.id, workflow_name: exec.workflow_name, text, created_at: deps.now().toISOString() });
      return { status: "success", chosen: "out", output: { note: text } };
    }

    case "action.assign": {
      const assignee = (config.assignee as string).trim();
      if (!live) return { status: "success", chosen: "out", output: { would_assign: assignee } };
      const runId = exec.run_id;
      if (runId === null) return { status: "error", error: "This step needs an invoice." };
      alive();
      assignRun(db, { run_id: runId, assignee, execution_id: exec.id, workflow_name: exec.workflow_name, created_at: deps.now().toISOString() });
      return { status: "success", chosen: "out", output: { assigned_to: assignee } };
    }

    case "action.webhook": {
      const fields = config.fields as { key: string; value: string }[];
      const body = JSON.stringify({
        event: EVENT_NAMES[exec.trigger_type] ?? "test",
        sent_at: deps.now().toISOString(),
        automation: { id: exec.workflow_id, name: exec.workflow_name },
        execution_id: exec.id,
        data: Object.fromEntries(fields.map((f) => [f.key, renderTemplate(f.value, vars, "none").text.slice(0, 2000)])),
      });
      return await sendStep(deps, exec, node, body, alive);
    }

    case "action.chat": {
      const body = JSON.stringify({ text: renderTemplate(config.text as string, vars, "slack").text.slice(0, 4000) });
      return await sendStep(deps, exec, node, body, alive);
    }
  }
}

/** The webhook and chat steps: a preview in a test, otherwise up to N attempts through the injected sender. */
async function sendStep(deps: AutomationDeps, exec: ExecutionRow, node: GraphNode, body: string, alive: () => void): Promise<NodeResult> {
  const { db } = deps;
  // The URL is read when the step runs, from the live row: a URL changed after the execution started is the one used.
  const workflow = getWorkflow(db, exec.workflow_id);
  if (workflow === null) return { status: "error", error: "The automation was deleted." };
  const secrets = parseSecrets(workflow.secrets)[node.id];
  const url = secrets?.url ?? null;
  let host: string | null = null;
  if (url !== null) {
    try {
      host = new URL(url).host;
    } catch {
      host = null;
    }
  }
  if (exec.mode === "test") {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    return { status: "success", chosen: "out", output: { preview: { host, body: parsed } }, attempts: 0 };
  }
  if (url === null) return { status: "error", error: "No webhook URL is set for this step." };
  if (countSendsSince(db, new Date(deps.now().getTime() - HOUR_MS).toISOString()) >= CONFIG.automationMaxSendsPerHour) {
    return { status: "error", error: `Skipped: the limit of ${CONFIG.automationMaxSendsPerHour} sends an hour was reached.` };
  }
  let attempts = 0;
  let last = { ok: false, status: 0, bodyText: "", error: "The webhook could not be reached." as string | null, retryable: false };
  for (let attempt = 1; attempt <= CONFIG.automationSendAttempts; attempt++) {
    alive();
    attempts = attempt;
    last = await deps.send({ url, body, signingSecret: secrets?.signing_secret ?? null, now: deps.now() }, deps.allowedHosts);
    if (last.ok || !last.retryable || attempt === CONFIG.automationSendAttempts) break;
    await deps.sleep(attempt === 1 ? 1000 : 4000);
  }
  const output = { host, status: last.status, response: last.bodyText };
  if (last.ok) return { status: "success", chosen: "out", output, attempts };
  return { status: "error", error: last.error ?? "The webhook could not be reached.", output, attempts };
}

