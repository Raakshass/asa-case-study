/**
 * Group "automations": the shared graph module (src/lib/workflow-graph.ts, plan A1) and, as the tasks land, the store,
 * the engine, the sender and the scheduler. No network, no model, a fixed clock.
 */
import { SEED_WORKFLOWS, ensureWorkflowsSeeded, insertSeedWorkflows, seedGraph } from "../../src/lib/automations/seed-workflows";
import {
  assignRun,
  addNote,
  claimExecution,
  countExecutionsSince,
  countSendsSince,
  deleteWorkflow,
  executionsForRun,
  finishExecution,
  getExecution,
  getWorkflow,
  insertExecution,
  listExecutions,
  listWorkflows,
  notesForRun,
  assignmentForRun,
  maskUrl,
  parseSecrets,
  saveWorkflow,
  setEnabled,
  writeStep,
  type ExecutionRow,
} from "../../src/lib/automations/store";
import {
  addStepAfter,
  addStepAt,
  connect,
  duplicateStep,
  freeOutputs,
  incoming,
  outlineRows,
  removeEdge,
  removeStep,
  renameStep,
  replaceTrigger,
  setConfig,
  setPosition,
} from "../../src/components/automations/graph-edit";
import { EventEmitter } from "node:events";
import type https from "node:https";
import crypto from "node:crypto";
import {
  automationsIdle,
  bumpAutomationGeneration,
  dispatchRunFinished,
  pauseAutomations,
  startTestExecution,
  type AutomationDeps,
} from "../../src/lib/automations/engine";
import { latestSlot, tickSchedules, type ScheduleConfig } from "../../src/lib/automations/schedule";
import { hostAllowed, isBlockedAddress, sendHttps, signPayload, type OutboundRequest, type OutboundResponse } from "../../src/lib/automations/send";
import { buildRunVars, buildSummaryVars } from "../../src/lib/automations/vars";
import { CONFIG } from "../../src/lib/config";
import type { DB } from "../../src/lib/db";
import { openDb, recoverInterruptedExecutions } from "../../src/lib/db";
import { seedDatabase } from "../../src/lib/seed";
import { formatUsd } from "../../src/lib/format";
import {
  CONFIG_SCHEMAS,
  GRAPH_MAX_EDGES,
  GRAPH_MAX_NODES,
  NODE_SPECS,
  NODE_TYPES,
  evaluateCondition,
  nextNodeId,
  renderTemplate,
  summarizeStep,
  templateVars,
  topoOrder,
  validateGraph,
  type Condition,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type Vars,
} from "../../src/lib/workflow-graph";
import { FIXED_NOW, openSeededMemoryDb, type Check } from "./harness";

/* ---- builders ---- */

const node = (id: string, type: NodeType, name: string, x: number, y: number, config?: unknown): GraphNode => ({
  id,
  type,
  name,
  position: { x, y },
  config: (config ?? NODE_SPECS[type].defaultConfig()) as Record<string, unknown>,
});
const edge = (source: string, sourceHandle: string, target: string): GraphEdge => ({ id: `${source}-${sourceHandle.toLowerCase()}-${target}`, source, sourceHandle, target });
const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): Graph => ({ nodes, edges });
const messages = (g: unknown, opts?: Parameters<typeof validateGraph>[1]): string[] => validateGraph(g, opts).problems.map((p) => p.message);

/** The three seed automations of plan 7.3, as the store seeds them. */
export function inlineSeeds(): { route: Graph; chat: Graph; daily: Graph } {
  const graph = (key: string): Graph => seedGraph(key) as Graph;
  return { route: graph("route-holds"), chat: graph("chat-rejections"), daily: graph("daily-holds") };
}

/** trigger -> note, to be varied by the tests below. */
const withNote = (text: string, trigger: GraphNode = node("start", "trigger.run_finished", "Start", 0, 0)): Graph =>
  graphOf([trigger, node("note", "action.note", "Note", 280, 0, { text })], [edge(trigger.id, "out", "note")]);

const execRow = (over: Partial<ExecutionRow> & Pick<ExecutionRow, "id" | "workflow_id" | "trigger_key">): ExecutionRow => ({
  workflow_name: "W",
  workflow_version: 1,
  graph: "{}",
  trigger_type: "run_finished",
  run_id: null,
  mode: "live",
  status: "queued",
  error: null,
  vars: "{}",
  created_at: FIXED_NOW.toISOString(),
  started_at: null,
  finished_at: null,
  ...over,
});

/* ---- helpers for the engine and sender tests ---- */

interface RunSeed {
  id: string;
  decision: "APPROVE" | "HOLD" | "REJECT" | null;
  status?: string;
  reasons?: string[];
  security?: boolean;
  total?: number | null;
  vendorId?: string | null;
  invoiceNumber?: string | null;
  poNumber?: string | null;
  finishedAt?: string;
  vendorName?: string | null;
  bankMismatch?: boolean;
}
/** A finished run and its invoice row, written the way the pipeline writes them (just what the engine reads). */
function addRun(db: DB, o: RunSeed): string {
  const at = o.finishedAt ?? FIXED_NOW.toISOString();
  const extraction = { vendor_name: o.vendorName === undefined ? "Globex Logistics Ltd" : o.vendorName, invoice_number: o.invoiceNumber ?? null, total: o.total ?? null };
  db.prepare(
    "INSERT INTO runs (id, file_name, file_hash, status, decision, decision_reasons, next_action, security_flag, extraction, model, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mock', ?, ?)",
  ).run(o.id, `${o.id}.pdf`, null, o.status ?? "done", o.decision, JSON.stringify(o.reasons ?? ["A reason."]), "Do the next thing.", o.security ? 1 : 0, JSON.stringify(extraction), at, at);
  if (o.decision !== null) {
    db.prepare(
      "INSERT INTO invoices (id, run_id, vendor_id, invoice_number, invoice_number_norm, invoice_date, po_number, po_inferred, subtotal, tax, total, currency, decision, created_at) VALUES (?, ?, ?, ?, ?, '2026-10-30', ?, 0, ?, 0, ?, 'USD', ?, ?)",
    ).run(o.id, o.id, o.vendorId === undefined ? "V003" : o.vendorId, o.invoiceNumber ?? null, o.invoiceNumber?.replace(/[^A-Z0-9]/g, "") ?? null, o.poNumber ?? null, o.total ?? null, o.total ?? null, o.decision, at);
  }
  if (o.bankMismatch) {
    db.prepare("INSERT INTO run_steps (run_id, idx, key, label, status, severity, reason, detail) VALUES (?, 6, 'vendor', 'Vendor check', 'fail', 'hold', 'x', ?)").run(o.id, JSON.stringify({ bank_mismatch: true }));
  }
  return o.id;
}

interface StubSender {
  calls: { req: OutboundRequest; allowedHosts: readonly string[] }[];
  send: AutomationDeps["send"];
}
/** A sender that records each call and answers from a queue (the last answer repeats). */
function stubSender(...answers: Partial<OutboundResponse>[]): StubSender {
  const calls: StubSender["calls"] = [];
  const queue = [...answers];
  return {
    calls,
    send: (req, allowedHosts) => {
      calls.push({ req, allowedHosts });
      const next = queue.length > 1 ? (queue.shift() as Partial<OutboundResponse>) : (queue[0] ?? {});
      return Promise.resolve({ ok: true, status: 200, bodyText: "ok", error: null, retryable: false, ...next });
    },
  };
}

function depsFor(db: DB, over: Partial<AutomationDeps> = {}): AutomationDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    db,
    now: () => FIXED_NOW,
    send: stubSender().send,
    allowedHosts: ["hooks.example.com"],
    baseUrl: null,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    reviewTrigger: true,
    ...over,
    sleeps,
  };
}

/** Sets the secret URL of one step of an automation (the editor's save does this through the API). */
function setUrl(db: DB, workflowId: string, nodeId: string, url: string | null, signingSecret?: string): void {
  db.prepare("UPDATE workflows SET secrets = ? WHERE id = ?").run(JSON.stringify(url === null ? {} : { [nodeId]: { url, ...(signingSecret ? { signing_secret: signingSecret } : {}) } }), workflowId);
}
const workflowBySeed = (db: DB, key: string) => listWorkflows(db).find((w) => w.seed_key === key) as ReturnType<typeof listWorkflows>[number];
const stepsOf = (db: DB, executionId: string) => getExecution(db, executionId)?.steps ?? [];
const only = <T,>(list: T[], what: string): T => {
  if (list.length !== 1) throw new Error(`expected one ${what}, got ${list.length}`);
  return list[0];
};

/** A fake of https.request: records its options and answers as scripted. */
interface FakeScript {
  status?: number;
  body?: string;
  neverEnds?: boolean;
  networkError?: boolean;
  bodyBytes?: number;
}
function fakeHttps(script: FakeScript = {}) {
  const calls: { options: Record<string, unknown>; written: string[]; destroyedWith: unknown[] }[] = [];
  const request = ((options: Record<string, unknown>, cb: (res: EventEmitter & { statusCode?: number; destroy(): void }) => void) => {
    const record = { options, written: [] as string[], destroyedWith: [] as unknown[] };
    calls.push(record);
    const req = new EventEmitter() as EventEmitter & { end(b?: string): void; destroy(e?: unknown): void };
    req.end = (b?: string) => {
      if (b) record.written.push(b);
      process.nextTick(() => {
        if (script.networkError) {
          req.emit("error", new Error("getaddrinfo ENOTFOUND secret.example.com"));
          return;
        }
        const res = new EventEmitter() as EventEmitter & { statusCode?: number; destroy(): void };
        res.statusCode = script.status ?? 200;
        res.destroy = () => undefined;
        cb(res);
        if (script.neverEnds) return;
        if (script.bodyBytes !== undefined) res.emit("data", Buffer.alloc(script.bodyBytes, "a"));
        else res.emit("data", Buffer.from(script.body ?? "ok"));
        res.emit("end");
      });
    };
    req.destroy = (e?: unknown) => {
      record.destroyedWith.push(e);
      process.nextTick(() => req.emit("error", e ?? new Error("destroyed")));
    };
    return req;
  }) as unknown as typeof https.request;
  return { request, calls };
}
const publicResolve = (addresses: { address: string; family: number }[] = [{ address: "8.8.8.8", family: 4 }]) => {
  const calls: string[] = [];
  return { calls, resolve: (host: string) => (calls.push(host), Promise.resolve(addresses)) };
};
const outbound = (url: string, over: Partial<OutboundRequest> = {}): OutboundRequest => ({ url, body: '{"text":"hi"}', signingSecret: null, now: new Date(1_700_000_000_000), ...over });

export async function run(t: Check): Promise<void> {
  await t.test("A1: the three seed graphs validate with no problems", () => {
    const seeds = inlineSeeds();
    for (const [name, g] of Object.entries(seeds)) t.eq(messages(g), [], name);
    // with URLs known the webhook-bearing seeds are still valid; without a URL the editor shows the missing one
    t.eq(messages(seeds.chat, { secrets: { chat: { has_url: true } } }), []);
    t.eq(messages(seeds.chat, { secrets: {} }), ["Add the webhook URL."]);
  });

  await t.test("A1: every catalogue entry has a settings schema, a default config that passes it, and labelled outputs", () => {
    for (const type of NODE_TYPES) {
      const spec = NODE_SPECS[type];
      t.eq(spec.type, type);
      t.ok(CONFIG_SCHEMAS[type].safeParse(spec.defaultConfig()).success, `${type}: the default config is valid`);
      t.ok(spec.outputs.length >= 1 && spec.outputs.every((o) => o.id !== "" && o.label !== ""), `${type}: outputs`);
    }
    t.eq(NODE_SPECS["logic.if"].outputs.map((o) => o.id), ["true", "false"]);
    t.eq(NODE_SPECS["logic.switch_decision"].outputs.map((o) => o.id), ["APPROVE", "HOLD", "REJECT", "ERROR"]);
  });

  await t.test("A1: an empty graph has no starting step; two triggers give one problem on the second", () => {
    t.eq(messages({ nodes: [], edges: [] }), ["Add a step that starts the automation."]);
    const two = graphOf([node("start", "trigger.run_finished", "A", 0, 0), node("other", "trigger.schedule", "B", 0, 100)], []);
    const problems = validateGraph(two).problems;
    t.eq(problems.map((p) => [p.node_id, p.message]), [["other", "An automation has exactly one starting step."]]);
  });

  await t.test("A1: a self-loop, a duplicate connection, a bad output and a connection into the trigger each give their message", () => {
    const base = withNote("hello");
    t.includes(messages({ ...base, edges: [...base.edges, edge("note", "out", "note")] }), "A step cannot connect to itself.");
    t.eq(messages({ ...base, edges: [...base.edges, { ...edge("start", "out", "note"), id: "again" }] }), ["These two steps are connected twice."]);
    t.eq(messages({ ...base, edges: [{ ...edge("start", "yes", "note") }] }).includes("This connection leaves from an output the step does not have."), true);
    t.includes(messages({ ...base, edges: [...base.edges, edge("note", "out", "start")] }), "Nothing can lead into the starting step.");
    t.includes(messages({ ...base, edges: [...base.edges, edge("start", "out", "ghost")] }), "A connection points to a step that does not exist.");
  });

  await t.test("A1: a cycle of three logic steps gives the cycle message and topoOrder is null", () => {
    const if1 = (id: string, y: number) => node(id, "logic.if", id, 280, y);
    const g = graphOf(
      [node("start", "trigger.run_finished", "Start", 0, 0), if1("a", 0), if1("b", 100), if1("c", 200)],
      [edge("start", "out", "a"), edge("a", "true", "b"), edge("b", "true", "c"), edge("c", "true", "a")],
    );
    t.eq(topoOrder(g), null);
    t.includes(messages(g), "The steps go round in a circle; remove one connection.");
    t.ok(!messages(withNote("x")).includes("The steps go round in a circle; remove one connection."), "no cycle in a plain graph");
  });

  await t.test("A1: a step the trigger does not reach is reported with its id", () => {
    const g = withNote("hello");
    g.nodes.push(node("lonely", "action.note", "Lonely", 560, 300, { text: "x" }));
    const problems = validateGraph(g).problems;
    t.eq(problems.map((p) => [p.node_id, p.message]), [["lonely", "This step is not connected to the start."]]);
  });

  await t.test("A1: a step that needs an invoice cannot follow a schedule trigger", () => {
    const g = withNote("Done", node("start", "trigger.schedule", "Daily", 0, 0));
    t.eq(messages(g), ["This step needs an invoice, but this automation runs on a schedule."]);
    t.eq(messages(graphOf([node("start", "trigger.schedule", "Daily", 0, 0), node("chat", "action.chat", "Chat", 280, 0, { text: "Hi" })], [edge("start", "out", "chat")])), [], "a chat message needs no invoice");
  });

  await t.test("A1: a value from a lookup is available only when EVERY path to the step went through it", () => {
    const note = (text: string) => node("note", "action.note", "Note", 840, 0, { text });
    t.eq(messages(withNote("Left {{po.remaining}}")), ['{{po.remaining}} is not available here: add "Look up the PO balance" before this step.']);
    const lookup = node("po", "data.po_balance", "PO", 280, 0);
    const straight = graphOf([node("start", "trigger.run_finished", "Start", 0, 0), lookup, note("Left {{po.remaining}}")], [edge("start", "out", "po"), edge("po", "out", "note")]);
    t.eq(messages(straight), [], "after the lookup it is available");
    // two branches merge into the note; only one of them did the lookup
    const branches = graphOf(
      [node("start", "trigger.run_finished", "Start", 0, 0), node("if", "logic.if", "If", 280, 0), lookup, node("skip", "action.assign", "Skip", 560, 140, { assignee: "x" }), note("Left {{po.remaining}}")],
      [edge("start", "out", "if"), edge("if", "true", "po"), edge("if", "false", "skip"), edge("po", "out", "note"), edge("skip", "out", "note")],
    );
    t.eq(messages(branches), ['{{po.remaining}} is not available here: add "Look up the PO balance" before this step.'], "intersection over the paths");
    t.includes(messages(withNote("{{summary.count}}")), 'add "Summarize recent invoices" before this step');
    t.includes(messages(withNote("{{run.total}}", node("start", "trigger.schedule", "Daily", 0, 0))), "it needs an automation that starts from an invoice");
    t.eq(messages(withNote("Reviewed: {{review.comment}}")), ["{{review.comment}} is not available here: it needs an automation that starts from an invoice."], "a review value needs the review trigger");
    t.eq(messages(withNote("Reviewed: {{review.comment}}", node("start", "trigger.review_saved", "Start", 0, 0))), []);
  });

  await t.test("A1: templates render values by type: money, yes/no, nothing for null, text without control characters", () => {
    const vars: Vars = { "run.total": 9900, "run.security_flag": true, "run.bank_change": false, "run.vendor_name": null, "run.reasons": "a\u0000b\u0007c\td\ne\rf\u0085g", "summary.count": 3 };
    t.eq(renderTemplate("Total {{run.total}}", vars, "none").text, `Total ${formatUsd(9900)}`);
    t.eq(renderTemplate("Total {{ run.total }}", vars, "none").text, "Total $9,900.00", "spaces inside the braces are fine");
    t.eq(renderTemplate("{{run.security_flag}}/{{run.bank_change}}", vars, "none").text, "yes/no");
    const none = renderTemplate("[{{run.vendor_name}}]", vars, "none");
    t.eq([none.text, none.missing], ["[]", []], "null is empty and not 'missing'");
    t.eq(renderTemplate("{{run.reasons}}", vars, "none").text, "abc\td\nefg", "control characters go; \\n and \\t stay");
    t.eq(renderTemplate("{{summary.count}} items", vars, "none").text, "3 items");
    const absent = renderTemplate("{{run.nope}} and {{run.id}} and {{run.nope}}", vars, "none");
    t.eq([absent.text, absent.missing], [" and  and ", ["run.nope", "run.id"]], "absent keys are replaced with nothing and listed once each");
    t.eq(templateVars("{{run.total}} {{ run.id }} {{run.total}} {not.a.var} {{Bad.Name}}"), ["run.total", "run.id"]);
  });

  await t.test("A1: escaping for chat changes the substituted value only, never the author's own text", () => {
    const vars: Vars = { "run.vendor_name": "<https://evil.example|Click> & co" };
    const out = renderTemplate("Vendor: {{run.vendor_name}} <https://ok.example|ok>", vars, "slack").text;
    t.eq(out, "Vendor: &lt;https://evil.example|Click&gt; &amp; co <https://ok.example|ok>");
    t.eq(renderTemplate("{{run.vendor_name}}", vars, "none").text, "<https://evil.example|Click> & co", "no escaping for a webhook's JSON");
  });

  await t.test("A1: an unknown value in a template is reported by validateGraph and listed as missing when rendered", () => {
    t.eq(messages(withNote("Hello {{run.nope}}")), ["Unknown value {{run.nope}}."]);
    t.eq(renderTemplate("Hello {{run.nope}}", {}, "none").missing, ["run.nope"]);
    for (const stray of ["{{ Run.Total }}", "{{process.env.X}}", "{{__proto__.toString}}"]) t.eq(messages(withNote(`A ${stray} B`)), [`Unknown value ${stray}.`], stray);
  });

  await t.test("A1: evaluateCondition, every operator against an absent value, null, a match and a non-match", () => {
    const c = (field: string, op: Condition["op"], value: Condition["value"]): Condition => ({ field, op, value });
    const cases: [string, Condition, Vars, boolean][] = [
      ["is, match (case and spaces ignored)", c("run.vendor_name", "is", "acme corp"), { "run.vendor_name": " Acme Corp " }, true],
      ["is, no match", c("run.vendor_name", "is", "acme"), { "run.vendor_name": "Acme Corp" }, false],
      ["is, absent", c("run.vendor_name", "is", "acme"), {}, false],
      ["is, null", c("run.vendor_name", "is", "acme"), { "run.vendor_name": null }, false],
      ["is_not, match", c("run.vendor_name", "is_not", "acme"), { "run.vendor_name": "Acme Corp" }, true],
      ["is_not, same", c("run.vendor_name", "is_not", "acme corp"), { "run.vendor_name": "Acme Corp" }, false],
      ["is_not, absent", c("run.vendor_name", "is_not", "acme"), {}, true],
      ["is_not, null", c("run.vendor_name", "is_not", "acme"), { "run.vendor_name": null }, true],
      ["contains, match", c("run.first_reason", "contains", "PO balance"), { "run.first_reason": "Exceeds remaining po balance by $3,000.00." }, true],
      ["contains, no match", c("run.first_reason", "contains", "duplicate"), { "run.first_reason": "Exceeds the PO balance" }, false],
      ["contains, absent", c("run.first_reason", "contains", "x"), {}, false],
      ["contains, null", c("run.first_reason", "contains", "x"), { "run.first_reason": null }, false],
      ["not_contains, no match", c("run.first_reason", "not_contains", "duplicate"), { "run.first_reason": "Exceeds the PO balance" }, true],
      ["not_contains, match", c("run.first_reason", "not_contains", "po balance"), { "run.first_reason": "Exceeds the PO balance" }, false],
      ["not_contains, absent", c("run.first_reason", "not_contains", "x"), {}, true],
      ["not_contains, null", c("run.first_reason", "not_contains", "x"), { "run.first_reason": null }, true],
      ["starts_with, match", c("run.invoice_number", "starts_with", "glx-"), { "run.invoice_number": "GLX-303" }, true],
      ["starts_with, no match", c("run.invoice_number", "starts_with", "inv"), { "run.invoice_number": "GLX-303" }, false],
      ["starts_with, absent", c("run.invoice_number", "starts_with", "g"), {}, false],
      ["starts_with, null", c("run.invoice_number", "starts_with", "g"), { "run.invoice_number": null }, false],
      ["gt, match", c("run.total", "gt", 5000), { "run.total": 5000.01 }, true],
      ["gt, equal", c("run.total", "gt", 5000), { "run.total": 5000 }, false],
      ["gt, null (no total printed)", c("run.total", "gt", 5000), { "run.total": null }, false],
      ["gt, absent", c("run.total", "gt", 5000), {}, false],
      ["gte, equal", c("run.total", "gte", 5000), { "run.total": 5000 }, true],
      ["gte, below", c("run.total", "gte", 5000), { "run.total": 4999.99 }, false],
      ["lt, below", c("run.total", "lt", 100), { "run.total": 99.99 }, true],
      ["lt, equal", c("run.total", "lt", 100), { "run.total": 100 }, false],
      ["lte, equal", c("run.total", "lte", 100), { "run.total": 100 }, true],
      ["lte, above", c("run.total", "lte", 100), { "run.total": 100.01 }, false],
      ["eq, match", c("summary.count", "eq", 3), { "summary.count": 3 }, true],
      ["eq, no match", c("summary.count", "eq", 3), { "summary.count": 2 }, false],
      ["eq, null", c("summary.count", "eq", 0), { "summary.count": null }, false],
      ["is_true, yes", c("run.security_flag", "is_true", null), { "run.security_flag": true }, true],
      ["is_true, no", c("run.security_flag", "is_true", null), { "run.security_flag": false }, false],
      ["is_true, null", c("run.security_flag", "is_true", null), { "run.security_flag": null }, false],
      ["is_true, absent", c("run.security_flag", "is_true", null), {}, false],
      ["is_false, no", c("run.security_flag", "is_false", null), { "run.security_flag": false }, true],
      ["is_false, yes", c("run.security_flag", "is_false", null), { "run.security_flag": true }, false],
      ["is_false, null", c("run.security_flag", "is_false", null), { "run.security_flag": null }, true],
      ["is_false, absent", c("run.security_flag", "is_false", null), {}, true],
      ["decision is, exact match", c("run.decision", "is", "HOLD"), { "run.decision": "HOLD" }, true],
      ["decision is, other case is not the token", c("run.decision", "is", "hold"), { "run.decision": "HOLD" }, false],
      ["decision is_not, other", c("run.decision", "is_not", "REJECT"), { "run.decision": "HOLD" }, true],
      ["decision is, null (a system error)", c("run.decision", "is", "HOLD"), { "run.decision": null }, false],
      ["an unknown field is never true", c("run.nope", "is", "x"), { "run.vendor_name": "x" }, false],
      ["a number operator on text is never true", c("run.vendor_name", "gt", 1), { "run.vendor_name": "x" }, false],
    ];
    t.ok(cases.length >= 24);
    for (const [what, cond, vars, expected] of cases) t.eq(evaluateCondition(cond, vars), expected, what);
  });

  await t.test("A1: an operator that does not suit the value, and a value of the wrong kind, are reported", () => {
    const withCondition = (condition: Condition): Graph => graphOf([node("start", "trigger.run_finished", "Start", 0, 0), node("if", "logic.if", "If", 280, 0, { combine: "all", conditions: [condition] })], [edge("start", "out", "if")]);
    t.eq(messages(withCondition({ field: "run.vendor_name", op: "gt", value: 5 })), ['"is more than" cannot be used with Vendor name.']);
    t.eq(messages(withCondition({ field: "run.finished_at", op: "is", value: "x" })), ['"is" cannot be used with Finished at.']);
    t.eq(messages(withCondition({ field: "run.total", op: "gt", value: "lots" })), ["Total needs a number."]);
    t.eq(messages(withCondition({ field: "run.decision", op: "is", value: "MAYBE" })), ["Decision needs one of: Approved, On hold, Rejected."]);
    t.eq(messages(withCondition({ field: "run.nope", op: "is", value: "x" })), ['Unknown value "run.nope" in a condition.']);
    t.eq(messages(withCondition({ field: "run.security_flag", op: "is_true", value: null })), []);
    t.eq(messages(withCondition({ field: "po.remaining", op: "lt", value: 100 })), ['{{po.remaining}} is not available here: add "Look up the PO balance" before this step.']);
  });

  await t.test("A1: topoOrder is stable: the same graph with its nodes shuffled gives the same order", () => {
    const g = inlineSeeds().route;
    const order = topoOrder(g);
    t.ok(order !== null);
    t.eq(order, ["start", "if-security", "assign-security", "note-security", "if-large", "assign-lead", "assign-clerk"].sort((a, b) => (order as string[]).indexOf(a) - (order as string[]).indexOf(b)));
    for (const shuffled of [[...g.nodes].reverse(), [g.nodes[3], g.nodes[0], g.nodes[6], g.nodes[1], g.nodes[5], g.nodes[2], g.nodes[4]]]) {
      t.eq(topoOrder({ nodes: shuffled, edges: [...g.edges].reverse() }), order, "order does not depend on the list order");
    }
    t.eq(order?.[0], "start", "the trigger is first");
  });

  await t.test("A1: more nodes or connections than the limits is not a graph at all", () => {
    const many: GraphNode[] = Array.from({ length: GRAPH_MAX_NODES + 1 }, (_, i) => node(`n-${i}`, "action.note", "N", i, 0, { text: "x" }));
    const out = validateGraph({ nodes: many, edges: [] });
    t.eq([out.graph, out.problems], [null, [{ node_id: null, message: "This automation could not be read." }]]);
    const edges = Array.from({ length: GRAPH_MAX_EDGES + 1 }, (_, i) => edge("a", "out", `b${i}`));
    t.eq(validateGraph({ nodes: [], edges }).graph, null);
    t.eq(validateGraph("nope").graph, null);
    t.eq(validateGraph({ nodes: [{ id: "A B" }], edges: [] }).graph, null, "a bad id is not a graph");
  });

  await t.test("A1: a step's settings that fail their schema are named, and the rest of the graph is still checked", () => {
    const g = withNote("ok");
    g.nodes.push(node("assign", "action.assign", "Assign", 560, 0, { assignee: 5 }), node("sched", "trigger.schedule", "Other", 0, 200, { every: "week", hour: 8, minute: 0 }));
    const problems = validateGraph(g).problems;
    t.ok(problems.some((p) => p.node_id === "assign" && p.message.startsWith("This step's settings are not valid: assignee ") && p.message.length <= 160), "assign");
    t.ok(problems.some((p) => p.node_id === "sched" && p.message.startsWith("This step's settings are not valid:")), "schedule");
    t.ok(problems.some((p) => p.node_id === "sched" && p.message === "An automation has exactly one starting step."), "and the second trigger is still reported");
  });

  await t.test("A1: trigger, step content and webhook rules", () => {
    const start = node("start", "trigger.run_finished", "Start", 0, 0, { decisions: [], include_errors: false });
    t.eq(messages(graphOf([start], [])), ["Choose at least one outcome to start on."]);
    t.eq(messages(graphOf([node("start", "trigger.run_finished", "Start", 0, 0, { decisions: [], include_errors: true })], [])), []);
    t.eq(messages(withNote("   ")), ["Write the note's text."]);
    const one = (n: GraphNode): Graph => graphOf([node("start", "trigger.run_finished", "Start", 0, 0), n], [edge("start", "out", n.id)]);
    t.eq(messages(one(node("a", "action.assign", "A", 280, 0, { assignee: " " }))), ["Write who to assign to."]);
    t.eq(messages(one(node("c", "action.chat", "C", 280, 0, { text: "" }))), ["Write the message."]);
    t.eq(messages(one(node("w", "action.webhook", "W", 280, 0, { fields: [] }))), ["Add at least one field to send."]);
    t.eq(messages(one(node("w", "action.webhook", "W", 280, 0, { fields: [{ key: "a", value: "1" }, { key: "a", value: "2" }] }))), ['Two fields are both called "a".']);
    t.eq(messages(one(node("w", "action.webhook", "W", 280, 0, { fields: [{ key: "Bad Key", value: "1" }] }))).length, 1, "a field key is lower-case letters, digits and _");
    const review = node("start", "trigger.review_saved", "Start", 0, 0);
    t.eq(messages(graphOf([review], []), { reviewTrigger: false }), ["Resolving holds is not available on this server."]);
    t.eq(messages(graphOf([review], [])), [], "the editor assumes it is available");
    t.eq(messages(one(node("w", "action.webhook", "W", 280, 0)), { secrets: { w: { has_url: false } } }), ["Add the webhook URL."]);
  });

  await t.test("A1: nextNodeId returns if-1, then if-2, and fills gaps", () => {
    const g = withNote("x");
    t.eq(nextNodeId(g, "logic.if"), "if-1");
    g.nodes.push(node("if-1", "logic.if", "If", 0, 0));
    t.eq(nextNodeId(g, "logic.if"), "if-2");
    g.nodes.push(node("if-2", "logic.if", "If", 0, 0), node("if-3", "logic.if", "If", 0, 0));
    g.nodes.splice(g.nodes.findIndex((n) => n.id === "if-2"), 1);
    t.eq(nextNodeId(g, "logic.if"), "if-2", "the lowest free number");
    t.eq(nextNodeId(withNote("x"), "action.note"), "note-1");
    t.eq(nextNodeId({ nodes: [], edges: [] }, "action.chat"), "chat-1");
  });

  await t.test("A1: summarizeStep writes one sentence for each step type", () => {
    const n = (type: NodeType, config?: unknown): GraphNode => node("x", type, "X", 0, 0, config);
    t.eq(summarizeStep(n("trigger.run_finished", { decisions: ["HOLD"], include_errors: false })), "Only invoices that are on hold");
    t.eq(summarizeStep(n("trigger.run_finished", { decisions: ["REJECT"], include_errors: false })), "Only invoices that are rejected");
    t.eq(summarizeStep(n("trigger.run_finished", { decisions: ["REJECT", "APPROVE"], include_errors: true })), "Only invoices that are approved or rejected, or end in a system error");
    t.eq(summarizeStep(n("trigger.run_finished", { decisions: ["APPROVE", "HOLD", "REJECT"], include_errors: false })), "Every decided invoice");
    t.eq(summarizeStep(n("trigger.review_saved", { actions: ["APPROVE", "REJECT"] })), "When a hold is approved or rejected");
    t.eq(summarizeStep(n("trigger.review_saved", { actions: ["REJECT"] })), "When a hold is rejected");
    t.eq(summarizeStep(n("trigger.schedule", { every: "day", hour: 8, minute: 0 })), "Every day at 08:00 UTC");
    t.eq(summarizeStep(n("trigger.schedule", { every: "hour", hour: 0, minute: 15 })), "Every hour at :15");
    t.eq(summarizeStep(n("logic.if", { combine: "all", conditions: [{ field: "run.security_flag", op: "is_true", value: null }] })), "If Security flag is yes");
    t.eq(summarizeStep(n("logic.if", { combine: "all", conditions: [{ field: "run.total", op: "gt", value: 5000 }, { field: "run.decision", op: "is", value: "HOLD" }, { field: "run.vendor_name", op: "contains", value: "Acme" }] })), "If Total is more than $5,000 and 2 more");
    t.eq(summarizeStep(n("logic.if", { combine: "any", conditions: [{ field: "run.decision", op: "is", value: "HOLD" }, { field: "run.vendor_name", op: "contains", value: "Acme" }] })), "If Decision is On hold or 1 more");
    t.eq(summarizeStep(n("logic.switch_decision", {})), "One way per decision");
    t.eq(summarizeStep(n("data.vendor", {})), "Look up the vendor");
    t.eq(summarizeStep(n("data.po_balance", {})), "Look up the PO balance");
    t.eq(summarizeStep(n("data.summarize", { window_hours: 24, decisions: ["HOLD"], max_items: 10 })), "Invoices on hold in the last 24 hours");
    t.eq(summarizeStep(n("data.summarize", { window_hours: 1, decisions: ["APPROVE", "HOLD"], max_items: 5 })), "Invoices approved or on hold in the last hour");
    t.eq(summarizeStep(n("action.note", { text: "" })), "No text yet");
    t.eq(summarizeStep(n("action.note", { text: "Security review needed before any payment: {{run.first_reason}}" })), "Security review needed before any payment: {{run.first_reas…"); // longer than 60 characters: cut
    t.eq(summarizeStep(n("action.note", { text: "x".repeat(60) })), "x".repeat(60), "exactly 60 characters is not cut");
    t.eq(summarizeStep(n("action.note", { text: "x".repeat(70) })), `${"x".repeat(59)}…`);
    t.eq(summarizeStep(n("action.assign", { assignee: "" })), "No one chosen yet");
    t.eq(summarizeStep(n("action.assign", { assignee: "AP lead" })), "Assign to AP lead");
    t.eq(summarizeStep(n("action.webhook", { fields: [{ key: "a", value: "1" }, { key: "b", value: "2" }] })), "Sends 2 fields");
    t.eq(summarizeStep(n("action.webhook", { fields: [{ key: "a", value: "1" }] })), "Sends 1 field");
    t.eq(summarizeStep(n("action.chat", { text: "" })), "No message yet");
    t.eq(summarizeStep(n("action.chat", { text: "Hello team" })), "Hello team");
    t.eq(summarizeStep(n("action.chat", { text: 5 })), "Settings are not valid", "a step with broken settings still gets a sentence");
  });

  /* ---------------------------------------------------------------------------- A2: tables, store, seeds */

  await t.test("A2: a seeded database has the three seed automations (seed 1 on, 2 and 3 off), valid and without secrets", () => {
    const db = openSeededMemoryDb();
    try {
      const rows = listWorkflows(db);
      t.eq(rows.map((r) => [r.seed_key, r.name, r.enabled, r.trigger_type, r.version, r.secrets]), [
        ["route-holds", "Route holds to the right person", 1, "run_finished", 1, "{}"],
        ["chat-rejections", "Tell the team about rejections", 0, "run_finished", 1, "{}"],
        ["daily-holds", "Morning summary of holds", 0, "schedule", 1, "{}"],
      ]);
      t.ok(rows[0].enabled_at !== null && rows[1].enabled_at === null && rows[2].enabled_at === null, "only an enabled seed has an enabled_at");
      for (const r of rows) t.eq(validateGraph(JSON.parse(r.graph)).problems.map((p) => p.message), [], r.name);
      t.eq(db.prepare("SELECT value FROM app_meta WHERE key = 'workflows_seeded'").pluck().get() !== undefined, true);
      t.eq(SEED_WORKFLOWS.map((s) => s.seed_key), ["route-holds", "chat-rejections", "daily-holds"]);
    } finally {
      db.close();
    }
  });

  await t.test("A2: ensureWorkflowsSeeded seeds an old database once, and never again, even after every automation is deleted", () => {
    const db = openDb(":memory:");
    try {
      t.eq(listWorkflows(db).length, 0, "a fresh schema has none");
      t.eq(ensureWorkflowsSeeded(db, FIXED_NOW), true);
      t.eq(listWorkflows(db).length, 3);
      t.eq(ensureWorkflowsSeeded(db, FIXED_NOW), false, "no-op the second time");
      for (const w of listWorkflows(db)) deleteWorkflow(db, w.id);
      t.eq(ensureWorkflowsSeeded(db, FIXED_NOW), false, "a person who deleted them all is not re-seeded");
      t.eq(listWorkflows(db).length, 0);
    } finally {
      db.close();
    }
  });

  await t.test("A2: a reset (seedDatabase) deletes executions, notes, assignments and user-made automations, and brings the seeds back", () => {
    const db = openSeededMemoryDb();
    try {
      const [first] = listWorkflows(db);
      const stamp = FIXED_NOW.toISOString();
      db.prepare("INSERT INTO workflows (id, name, enabled, trigger_type, graph, created_at, updated_at) VALUES ('mine', 'Mine', 0, 'run_finished', '{}', ?, ?)").run(stamp, stamp);
      t.eq(insertExecution(db, execRow({ id: "x1", workflow_id: first.id, trigger_key: "run:r1", run_id: "r1" })), true);
      writeStep(db, { execution_id: "x1", node_id: "start", idx: 0, type: "trigger.run_finished", name: "s", status: "success", chosen_output: "out", output: "{}", error: null, attempts: 0, started_at: stamp, finished_at: stamp });
      addNote(db, { id: "n1", run_id: "r1", execution_id: "x1", workflow_name: "W", text: "hi", created_at: stamp });
      assignRun(db, { run_id: "r1", assignee: "AP lead", execution_id: "x1", workflow_name: "W", created_at: stamp });
      seedDatabase(db);
      const after = listWorkflows(db);
      t.eq(after.map((w) => w.seed_key), ["route-holds", "chat-rejections", "daily-holds"], "only the seeds");
      t.ok(getWorkflow(db, "mine") === null, "the user-made automation is gone");
      for (const table of ["workflow_executions", "workflow_execution_steps", "run_notes", "run_assignments"]) t.eq(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
      t.eq(after.map((w) => w.enabled), [1, 0, 0]);
    } finally {
      db.close();
    }
  });

  await t.test("A2: saveWorkflow needs the current version; a wrong one is refused, a missing automation is not_found", () => {
    const db = openSeededMemoryDb();
    try {
      const w = listWorkflows(db)[0];
      const input = { name: "Renamed", graph: w.graph, secrets: "{}", triggerType: "run_finished", enabled: true, enabledAt: w.enabled_at, now: "2026-11-03T10:00:00.000Z" };
      t.eq(saveWorkflow(db, w.id, { ...input, expectedVersion: 5 }), { ok: false, reason: "version" });
      t.eq(saveWorkflow(db, "nope", { ...input, expectedVersion: 1 }), { ok: false, reason: "not_found" });
      t.eq(saveWorkflow(db, w.id, { ...input, expectedVersion: 1 }), { ok: true, version: 2 });
      t.eq(saveWorkflow(db, w.id, { ...input, expectedVersion: 1 }), { ok: false, reason: "version" }, "the same version twice");
      const saved = getWorkflow(db, w.id);
      t.eq([saved?.name, saved?.version, saved?.updated_at], ["Renamed", 2, "2026-11-03T10:00:00.000Z"]);
    } finally {
      db.close();
    }
  });

  await t.test("A2: setEnabled stamps enabled_at only when turning on; deleteWorkflow removes executions and steps but keeps notes and assignments", () => {
    const db = openSeededMemoryDb();
    try {
      const w = listWorkflows(db)[1];
      t.eq(setEnabled(db, w.id, true, "2026-11-03T08:00:00.000Z"), true);
      t.eq([getWorkflow(db, w.id)?.enabled, getWorkflow(db, w.id)?.enabled_at], [1, "2026-11-03T08:00:00.000Z"]);
      t.eq(setEnabled(db, w.id, false, "2026-11-03T09:00:00.000Z"), true);
      t.eq([getWorkflow(db, w.id)?.enabled, getWorkflow(db, w.id)?.enabled_at], [0, "2026-11-03T08:00:00.000Z"], "turning off keeps the old stamp");
      t.eq(setEnabled(db, "nope", true, "x"), false);
      insertExecution(db, execRow({ id: "x1", workflow_id: w.id, trigger_key: "run:r1", run_id: "r1" }));
      writeStep(db, { execution_id: "x1", node_id: "start", idx: 0, type: "trigger.run_finished", name: "s", status: "success", chosen_output: "out", output: null, error: null, attempts: 0, started_at: null, finished_at: null });
      addNote(db, { id: "n1", run_id: "r1", execution_id: "x1", workflow_name: "W", text: "kept", created_at: FIXED_NOW.toISOString() });
      assignRun(db, { run_id: "r1", assignee: "AP clerk", execution_id: "x1", workflow_name: "W", created_at: FIXED_NOW.toISOString() });
      t.eq(deleteWorkflow(db, w.id), true);
      t.eq([db.prepare("SELECT COUNT(*) FROM workflow_executions").pluck().get(), db.prepare("SELECT COUNT(*) FROM workflow_execution_steps").pluck().get()], [0, 0]);
      t.eq([db.prepare("SELECT COUNT(*) FROM run_notes").pluck().get(), db.prepare("SELECT COUNT(*) FROM run_assignments").pluck().get()], [1, 1], "they record what happened");
      t.eq(deleteWorkflow(db, w.id), false, "already gone");
    } finally {
      db.close();
    }
  });

  await t.test("A2: insertExecution is idempotent on (workflow, trigger key); a claim succeeds once; finishing and reading back", () => {
    const db = openSeededMemoryDb();
    try {
      const w = listWorkflows(db)[0];
      t.eq(insertExecution(db, execRow({ id: "a", workflow_id: w.id, trigger_key: "run:r1", run_id: "r1" })), true);
      t.eq(insertExecution(db, execRow({ id: "b", workflow_id: w.id, trigger_key: "run:r1", run_id: "r1" })), false, "the same invoice twice");
      t.eq(insertExecution(db, execRow({ id: "c", workflow_id: listWorkflows(db)[1].id, trigger_key: "run:r1", run_id: "r1" })), true, "another automation may run for it");
      t.eq(claimExecution(db, "a", "2026-11-03T10:00:00.000Z"), true);
      t.eq(claimExecution(db, "a", "2026-11-03T10:00:01.000Z"), false, "already running");
      writeStep(db, { execution_id: "a", node_id: "n2", idx: 2, type: "action.note", name: "second", status: "success", chosen_output: "out", output: "{}", error: null, attempts: 0, started_at: null, finished_at: null });
      writeStep(db, { execution_id: "a", node_id: "n1", idx: 1, type: "logic.if", name: "first", status: "success", chosen_output: "true", output: "{}", error: null, attempts: 0, started_at: null, finished_at: null });
      finishExecution(db, "a", "success", null, "2026-11-03T10:00:02.000Z");
      const got = getExecution(db, "a");
      t.eq([got?.execution.status, got?.execution.started_at, got?.execution.finished_at], ["success", "2026-11-03T10:00:00.000Z", "2026-11-03T10:00:02.000Z"]);
      t.eq(got?.steps.map((x) => x.node_id), ["n1", "n2"], "steps come back in idx order");
      t.eq(getExecution(db, "zzz"), null);
      t.eq(executionsForRun(db, "r1").map((x) => x.id), ["a", "c"]);
      t.eq(listExecutions(db, w.id, 10).map((x) => x.id), ["a"]);
    } finally {
      db.close();
    }
  });

  await t.test("A2: pruning keeps the newest executions of one automation (and deletes their steps), others are untouched", () => {
    const db = openSeededMemoryDb();
    const real = CONFIG.automationKeepExecutions;
    try {
      (CONFIG as { automationKeepExecutions: number }).automationKeepExecutions = 3;
      const [a, b] = listWorkflows(db);
      for (let i = 1; i <= 5; i++) {
        insertExecution(db, execRow({ id: `a${i}`, workflow_id: a.id, trigger_key: `run:${i}`, created_at: `2026-11-03T10:00:0${i}.000Z` }));
        writeStep(db, { execution_id: `a${i}`, node_id: "start", idx: 0, type: "trigger.run_finished", name: "s", status: "success", chosen_output: "out", output: null, error: null, attempts: 0, started_at: null, finished_at: null });
      }
      insertExecution(db, execRow({ id: "b1", workflow_id: b.id, trigger_key: "run:1" }));
      t.eq(listExecutions(db, a.id, 10).map((x) => x.id), ["a5", "a4", "a3"], "3 remain, the newest");
      t.eq(db.prepare("SELECT execution_id FROM workflow_execution_steps ORDER BY execution_id").pluck().all(), ["a3", "a4", "a5"], "no orphaned steps");
      t.eq(listExecutions(db, b.id, 10).length, 1, "another automation is untouched");
    } finally {
      (CONFIG as { automationKeepExecutions: number }).automationKeepExecutions = real;
      db.close();
    }
  });

  await t.test("A2: the hourly counters count executions since a time, and every send attempt of webhook and chat steps", () => {
    const db = openSeededMemoryDb();
    try {
      const w = listWorkflows(db)[0];
      insertExecution(db, execRow({ id: "e1", workflow_id: w.id, trigger_key: "k1", created_at: "2026-11-03T09:00:00.000Z" }));
      insertExecution(db, execRow({ id: "e2", workflow_id: w.id, trigger_key: "k2", created_at: "2026-11-03T10:30:00.000Z" }));
      t.eq([countExecutionsSince(db, "2026-11-03T10:00:00.000Z"), countExecutionsSince(db, "2026-11-03T08:00:00.000Z")], [1, 2]);
      const step = (node: string, type: string, attempts: number, at: string) => writeStep(db, { execution_id: "e2", node_id: node, idx: 0, type, name: node, status: "success", chosen_output: "out", output: null, error: null, attempts, started_at: at, finished_at: at });
      step("c1", "action.chat", 3, "2026-11-03T10:31:00.000Z");
      step("w1", "action.webhook", 1, "2026-11-03T10:32:00.000Z");
      step("old", "action.chat", 2, "2026-11-03T08:00:00.000Z");
      step("note", "action.note", 0, "2026-11-03T10:33:00.000Z");
      t.eq(countSendsSince(db, "2026-11-03T10:00:00.000Z"), 4, "3 + 1; the old one and the note do not count");
      t.eq(countSendsSince(db, "2026-11-03T12:00:00.000Z"), 0);
    } finally {
      db.close();
    }
  });

  await t.test("A2: startup recovery turns a queued or running execution into an error and leaves finished ones alone", () => {
    const db = openDb(":memory:");
    try {
      insertSeedWorkflows(db, FIXED_NOW.toISOString());
      const w = listWorkflows(db)[0];
      for (const [id, status] of [["q", "queued"], ["r", "running"], ["s", "success"], ["e", "error"]] as const) insertExecution(db, execRow({ id, workflow_id: w.id, trigger_key: id, status }));
      t.eq(recoverInterruptedExecutions(db, FIXED_NOW), 2);
      const rows = ["q", "r", "s", "e"].map((id) => getExecution(db, id)?.execution);
      t.eq(rows.map((x) => [x?.status, x?.error]), [["error", "Interrupted by restart."], ["error", "Interrupted by restart."], ["success", null], ["error", null]]);
      t.eq(rows[0]?.finished_at, FIXED_NOW.toISOString());
    } finally {
      db.close();
    }
  });

  await t.test("A2: maskUrl shows the host and the last 4 characters of a long path; parseSecrets never throws", () => {
    t.eq(maskUrl("https://hooks.slack.com/services/T000/B000/XXXXabcd"), "hooks.slack.com/…/abcd");
    t.eq(maskUrl("https://hooks.example.com/T000/B000/a1b2"), "hooks.example.com/…/a1b2");
    t.eq(maskUrl("https://hooks.example.com/a1b2"), "hooks.example.com", "a short path shows only the host");
    t.eq(maskUrl("https://hooks.example.com"), "hooks.example.com");
    t.eq(maskUrl("not a url"), "(not a valid URL)");
    t.ok(!maskUrl("https://hooks.slack.com/services/T000/B000/XXXXabcd").includes("services"), "nothing of the middle of the path");
    t.eq(parseSecrets('{"chat":{"url":"https://x.example/abc","signing_secret":"s3"},"bad":5,"empty":{"url":""}}'), { chat: { url: "https://x.example/abc", signing_secret: "s3" } });
    t.eq([parseSecrets("{nope"), parseSecrets("[]"), parseSecrets("null"), parseSecrets("{}")], [{}, {}, {}, {}]);
  });

  await t.test("A2: the graph limits equal the configured limits", () => {
    t.eq([GRAPH_MAX_NODES, GRAPH_MAX_EDGES], [CONFIG.automationMaxNodes, CONFIG.automationMaxEdges]);
  });

  /* ---------------------------------------------------------------------------- A4: engine and variables */

  await t.test("A4: the first seed assigns each hold to the right person: security, large, the rest (and a null total counts as not large)", async () => {
    const db = openSeededMemoryDb();
    try {
      const deps = depsFor(db);
      const cases: [string, RunSeed, string, boolean][] = [
        ["lead", { id: "r-lead", decision: "HOLD", total: 9900, invoiceNumber: "GLX-303" }, "AP lead", false],
        ["clerk", { id: "r-clerk", decision: "HOLD", total: 1650, invoiceNumber: "IF-2210" }, "AP clerk", false],
        ["security", { id: "r-sec", decision: "HOLD", total: 4620, security: true, reasons: ["Hidden instruction quoted."] }, "Finance security", true],
        ["no total", { id: "r-none", decision: "HOLD", total: null }, "AP clerk", false],
      ];
      for (const [, seed] of cases) addRun(db, seed);
      for (const [, seed] of cases) dispatchRunFinished(deps, seed.id);
      await automationsIdle();
      for (const [name, seed, assignee, noted] of cases) {
        const ex = only(executionsForRun(db, seed.id), `execution for ${name}`);
        t.eq([ex.status, ex.error, ex.mode, ex.trigger_key], ["success", null, "live", `run:${seed.id}`], name);
        t.eq(assignmentForRun(db, seed.id)?.assignee, assignee, name);
        const notes = notesForRun(db, seed.id);
        t.eq(notes.length, noted ? 1 : 0, `${name}: notes`);
        if (noted) t.eq(notes[0].text, "Security review needed before any payment: Hidden instruction quoted.");
      }
      for (const [id, decision] of [["r-ok", "APPROVE"], ["r-no", "REJECT"]] as const) {
        addRun(db, { id, decision, total: 100 });
        dispatchRunFinished(deps, id);
      }
      await automationsIdle();
      t.eq([executionsForRun(db, "r-ok").length, executionsForRun(db, "r-no").length], [0, 0], "an approved or rejected run starts nothing (seed 2 is off)");
    } finally {
      db.close();
    }
  });

  await t.test("A4: dispatching the same run twice starts it once; skipped steps are recorded; each step keeps its chosen output and output", async () => {
    const db = openSeededMemoryDb();
    try {
      const deps = depsFor(db);
      addRun(db, { id: "r1", decision: "HOLD", total: 9900 });
      dispatchRunFinished(deps, "r1");
      dispatchRunFinished(deps, "r1");
      await automationsIdle();
      const ex = only(executionsForRun(db, "r1"), "execution");
      const steps = stepsOf(db, ex.id);
      t.eq(steps.map((x) => [x.node_id, x.status, x.chosen_output]), [
        ["start", "success", "out"],
        ["if-security", "success", "false"],
        ["assign-security", "skipped", null],
        ["note-security", "skipped", null],
        ["if-large", "success", "true"],
        ["assign-lead", "success", "out"],
        ["assign-clerk", "skipped", null],
      ], "in topological order, the untaken branch skipped");
      const ifStep = steps.find((x) => x.node_id === "if-large");
      t.eq(JSON.parse(ifStep?.output ?? "null"), { result: true, checked: [{ field: "run.total", op: "gt", value: 5000, actual: "9900" }] }, "the condition's evidence");
      t.eq(JSON.parse(steps.find((x) => x.node_id === "assign-lead")?.output ?? "null"), { assigned_to: "AP lead" });
      t.eq(ex.workflow_name, "Route holds to the right person");
      t.eq(JSON.parse(ex.vars)["workflow.name"], "Route holds to the right person");
    } finally {
      db.close();
    }
  });

  await t.test("A4: buildRunVars reads the run: decision words, joined reasons, bank change, total, URL; a missing or history run is null", () => {
    const db = openSeededMemoryDb();
    try {
      addRun(db, { id: "r1", decision: "HOLD", total: 9900, invoiceNumber: "GLX-303", poNumber: "PO-1003", reasons: ["First.", "Second."], bankMismatch: true });
      const vars = buildRunVars(db, "r1", "https://ap.example.com", FIXED_NOW) as Vars;
      t.eq(vars["run.url"], "https://ap.example.com/runs/r1");
      t.eq([vars["run.decision"], vars["run.decision_text"], vars["run.first_reason"], vars["run.reasons"]], ["HOLD", "On hold", "First.", "First.; Second."]);
      t.eq([vars["run.bank_change"], vars["run.total"], vars["run.invoice_number"], vars["run.po_number"], vars["run.vendor_name"], vars["run.vendor_id"]], [true, 9900, "GLX-303", "PO-1003", "Globex Logistics Ltd", "V003"]);
      t.eq([vars["now.date"], vars["run.security_flag"], vars["run.po_inferred"]], ["2026-11-02", false, false]);
      t.eq(buildRunVars(db, "r1", null, FIXED_NOW)?.["run.url"], "/runs/r1", "no base URL: a relative link");
      t.eq(buildRunVars(db, "nope", null), null);
      const history = db.prepare("SELECT id FROM runs WHERE model = 'history' LIMIT 1").pluck().get() as string;
      t.eq(buildRunVars(db, history, null), null, "a pre-loaded history row is not a run to automate");
      addRun(db, { id: "r-err", decision: null, status: "error" });
      const err = buildRunVars(db, "r-err", null) as Vars;
      t.eq([err["run.decision"], err["run.decision_text"], err["run.vendor_id"]], [null, "System error", null]);
      addRun(db, { id: "r-long", decision: "HOLD", reasons: ["x".repeat(600)], vendorName: "v".repeat(500) });
      const long = buildRunVars(db, "r-long", null) as Vars;
      t.ok(String(long["run.first_reason"]).length <= 500 && String(long["run.vendor_name"]).length <= 200, "texts from the invoice are capped");
    } finally {
      db.close();
    }
  });

  await t.test("A4: the split by decision takes the output named after the decision, and ERROR for a system error", async () => {
    const db = openSeededMemoryDb();
    try {
      const deps = depsFor(db);
      const [seed] = listWorkflows(db);
      const graph: Graph = {
        nodes: [
          node("start", "trigger.run_finished", "Start", 0, 0, { decisions: ["APPROVE", "HOLD", "REJECT"], include_errors: true }),
          node("switch", "logic.switch_decision", "Split", 280, 0, {}),
          node("a", "action.note", "Approved note", 560, -100, { text: "approved" }),
          node("h", "action.note", "Hold note", 560, 0, { text: "held" }),
          node("e", "action.note", "Error note", 560, 100, { text: "system error" }),
        ],
        edges: [edge("start", "out", "switch"), edge("switch", "APPROVE", "a"), edge("switch", "HOLD", "h"), edge("switch", "ERROR", "e")],
      };
      db.prepare("UPDATE workflows SET graph = ?, enabled = 1 WHERE id = ?").run(JSON.stringify(graph), seed.id);
      db.prepare("UPDATE workflows SET enabled = 0 WHERE id != ?").run(seed.id);
      addRun(db, { id: "ra", decision: "APPROVE" });
      addRun(db, { id: "rh", decision: "HOLD" });
      addRun(db, { id: "rr", decision: "REJECT" });
      addRun(db, { id: "re", decision: null, status: "error" });
      for (const id of ["ra", "rh", "rr", "re"]) dispatchRunFinished(deps, id);
      await automationsIdle();
      t.eq(["ra", "rh", "rr", "re"].map((id) => notesForRun(db, id).map((n) => n.text)), [["approved"], ["held"], [], ["system error"]], "REJECT has no output connected, so it just stops");
      const switchStep = stepsOf(db, only(executionsForRun(db, "re"), "e").id).find((x) => x.node_id === "switch");
      t.eq([switchStep?.chosen_output, JSON.parse(switchStep?.output ?? "null")], ["ERROR", { decision: "ERROR" }]);
    } finally {
      db.close();
    }
  });

  await t.test("A4: a trigger that does not list an outcome starts nothing; include_errors starts on a system error", async () => {
    const db = openSeededMemoryDb();
    try {
      const deps = depsFor(db);
      addRun(db, { id: "rh", decision: "HOLD" });
      addRun(db, { id: "re", decision: null, status: "error" });
      dispatchRunFinished(deps, "re");
      await automationsIdle();
      t.eq(executionsForRun(db, "re").length, 0, "the seed lists only HOLD");
      const seed = workflowBySeed(db, "route-holds");
      const graph = JSON.parse(seed.graph) as Graph;
      (graph.nodes[0].config as Record<string, unknown>).include_errors = true;
      db.prepare("UPDATE workflows SET graph = ? WHERE id = ?").run(JSON.stringify(graph), seed.id);
      dispatchRunFinished(deps, "re");
      await automationsIdle();
      const ex = only(executionsForRun(db, "re"), "execution");
      t.eq(ex.status, "success", "it started, and the steps that need a decision still ran their own way");
    } finally {
      db.close();
    }
  });

  await t.test("A4: a test execution writes no note or assignment, ignores enabled and the outcome filter, and shows what would be written", async () => {
    const db = openSeededMemoryDb();
    try {
      const deps = depsFor(db);
      const off = workflowBySeed(db, "chat-rejections");
      addRun(db, { id: "r4", decision: "REJECT", total: 400, invoiceNumber: "INV-0042" });
      const started = startTestExecution(deps, off.id, "r4", false);
      t.ok(started.ok, "a disabled automation can be tested");
      await automationsIdle();
      if (!started.ok) return;
      const ex = getExecution(db, started.executionId)?.execution;
      t.eq([ex?.status, ex?.mode, ex?.trigger_type, ex?.run_id, ex?.trigger_key.startsWith("test:")], ["success", "test", "test", "r4", true]);
      // seed 1 (on) with a REJECT run: the filter says HOLD only, a test ignores it and writes nothing
      const route = workflowBySeed(db, "route-holds");
      const second = startTestExecution(deps, route.id, "r4", false);
      await automationsIdle();
      if (!second.ok) throw new Error("test did not start");
      const steps = stepsOf(db, second.executionId);
      t.eq(steps.map((x) => x.status), ["success", "success", "skipped", "skipped", "success", "skipped", "success"], "a REJECT run with a small total goes to the clerk");
      t.eq(JSON.parse(steps.find((x) => x.node_id === "assign-clerk")?.output ?? "null"), { would_assign: "AP clerk" });
      t.eq([notesForRun(db, "r4").length, assignmentForRun(db, "r4")], [0, null], "nothing written");
      t.eq(executionsForRun(db, "r4").length, 2, "both tests are recorded");
    } finally {
      db.close();
    }
  });

  await t.test("A4: startTestExecution refuses what cannot be tested, with fixed sentences", () => {
    const db = openSeededMemoryDb();
    try {
      const deps = depsFor(db);
      const route = workflowBySeed(db, "route-holds");
      t.eq(startTestExecution(deps, "nope", null, false), { ok: false, status: 404, error: "Automation not found." });
      t.eq(startTestExecution(deps, route.id, null, false), { ok: false, status: 400, error: "Choose a finished invoice to test with." });
      t.eq(startTestExecution(deps, route.id, "ghost", false), { ok: false, status: 400, error: "Choose a finished invoice to test with." });
      const history = db.prepare("SELECT id FROM runs WHERE model = 'history' LIMIT 1").pluck().get() as string;
      t.eq(startTestExecution(deps, route.id, history, false), { ok: false, status: 400, error: "Choose a finished invoice to test with." }, "a history row");
      db.prepare("INSERT INTO runs (id, status, created_at, model) VALUES ('queued-run', 'queued', ?, 'mock')").run(FIXED_NOW.toISOString());
      t.eq(startTestExecution(deps, route.id, "queued-run", false).ok, false, "a run that has not finished");
      db.prepare("UPDATE workflows SET graph = ? WHERE id = ?").run(JSON.stringify({ nodes: [], edges: [] }), route.id);
      t.eq(startTestExecution(deps, route.id, null, false), { ok: false, status: 409, error: "Fix the problems listed before testing." });
      db.prepare("UPDATE workflows SET graph = 'not json' WHERE id = ?").run(route.id);
      t.eq(startTestExecution(deps, route.id, null, false), { ok: false, status: 409, error: "Fix the problems listed before testing." }, "an unreadable graph");
    } finally {
      db.close();
    }
  });

  await t.test("A4: a test of a schedule automation ignores the run; a review trigger needs a reviewed run", async () => {
    const db = openSeededMemoryDb();
    try {
      const deps = depsFor(db);
      const daily = workflowBySeed(db, "daily-holds");
      addRun(db, { id: "h1", decision: "HOLD", total: 9900, invoiceNumber: "GLX-303", reasons: ["Exceeds remaining PO balance by $3,000.00."], finishedAt: "2026-11-02T08:00:00.000Z" });
      const started = startTestExecution(deps, daily.id, "ignored", false);
      await automationsIdle();
      if (!started.ok) throw new Error("did not start");
      const ex = getExecution(db, started.executionId);
      t.eq([ex?.execution.run_id, ex?.execution.status], [null, "success"]);
      const chat = ex?.steps.find((x) => x.node_id === "chat");
      const preview = JSON.parse(chat?.output ?? "null").preview;
      t.eq(preview.host, null, "no URL set yet: the preview says so");
      t.ok(String(preview.body.text).startsWith("1 invoices on hold in the last 24 hours ($9,900.00):"), preview.body.text);
      t.includes(preview.body.text, "GLX-303, Globex Logistics Ltd, $9,900.00: Exceeds remaining PO balance by $3,000.00.");
      // a review trigger
      const review: Graph = { nodes: [node("start", "trigger.review_saved", "Start", 0, 0, { actions: ["APPROVE"] }), node("note", "action.note", "Note", 280, 0, { text: "Approved after review: {{review.comment}}" })], edges: [edge("start", "out", "note")] };
      const route = workflowBySeed(db, "route-holds");
      db.prepare("UPDATE workflows SET graph = ?, trigger_type = 'review_saved' WHERE id = ?").run(JSON.stringify(review), route.id);
      t.eq(startTestExecution(deps, route.id, "h1", false), { ok: false, status: 400, error: "That invoice has not been reviewed yet; choose one that has." });
      db.prepare("INSERT INTO run_reviews (id, run_id, action, comment, po_number, previous_decision, created_at) VALUES ('rv', 'h1', 'APPROVE', 'Checked with the buyer.', NULL, 'HOLD', ?)").run(FIXED_NOW.toISOString());
      const ok = startTestExecution(deps, route.id, "h1", false);
      await automationsIdle();
      if (!ok.ok) throw new Error("did not start");
      t.eq(JSON.parse(stepsOf(db, ok.executionId).find((x) => x.node_id === "note")?.output ?? "null"), { would_write: "Approved after review: Checked with the buyer." });
      t.eq(startTestExecution({ ...deps, reviewTrigger: false }, route.id, "h1", false), { ok: false, status: 409, error: "Fix the problems listed before testing." }, "without the review feature the trigger is a problem");
    } finally {
      db.close();
    }
  });

  await t.test("A4: data steps: the vendor and PO lookups add values, and each failure has its own sentence", async () => {
    const db = openSeededMemoryDb();
    try {
      const deps = depsFor(db);
      const route = workflowBySeed(db, "route-holds");
      const graph: Graph = {
        nodes: [
          node("start", "trigger.run_finished", "Start", 0, 0, { decisions: ["HOLD"], include_errors: false }),
          node("vendor", "data.vendor", "Vendor", 280, 0),
          node("po", "data.po_balance", "PO", 560, 0),
          node("note", "action.note", "Note", 840, 0, { text: "{{vendor.name}} approved={{vendor.approved}} {{po.number}} left {{po.remaining}} of {{po.subtotal}} ({{po.status}})" }),
        ],
        edges: [edge("start", "out", "vendor"), edge("vendor", "out", "po"), edge("po", "out", "note")],
      };
      db.prepare("UPDATE workflows SET graph = ? WHERE id = ?").run(JSON.stringify(graph), route.id);
      addRun(db, { id: "ok", decision: "HOLD", poNumber: "PO-1003", vendorId: "V003" });
      addRun(db, { id: "no-vendor", decision: "HOLD", vendorId: null, poNumber: "PO-1003" });
      addRun(db, { id: "no-po", decision: "HOLD", vendorId: "V003", poNumber: null });
      addRun(db, { id: "ghost-po", decision: "HOLD", vendorId: "V003", poNumber: "PO-9999" });
      for (const id of ["ok", "no-vendor", "no-po", "ghost-po"]) dispatchRunFinished(deps, id);
      await automationsIdle();
      t.eq(notesForRun(db, "ok").map((n) => n.text), ["Globex Logistics Ltd approved=yes PO-1003 left $6,000.00 of $30,000.00 (open)"]);
      const errorOf = (id: string) => {
        const ex = only(executionsForRun(db, id), "execution");
        return [ex.status, ex.error, stepsOf(db, ex.id).filter((x) => x.status === "error").map((x) => x.error), stepsOf(db, ex.id).filter((x) => x.status === "skipped").length];
      };
      t.eq(errorOf("no-vendor"), ["error", "One or more steps failed; see the steps.", ["This invoice's vendor is not in the vendor master."], 2], "the steps after a failed one are skipped");
      t.eq(errorOf("no-po"), ["error", "One or more steps failed; see the steps.", ["This invoice has no PO."], 1]);
      t.eq(errorOf("ghost-po"), ["error", "One or more steps failed; see the steps.", ["The PO is not in the procurement data."], 1]);
    } finally {
      db.close();
    }
  });

  await t.test("A4: the summary lists the recent invoices of the chosen outcomes, newest first, capped, and a resolved hold is no longer a hold", () => {
    const db = openSeededMemoryDb();
    try {
      for (let i = 1; i <= 4; i++) addRun(db, { id: `h${i}`, decision: "HOLD", total: 100 * i, invoiceNumber: `INV-${i}`, reasons: [`Reason ${i}.`], finishedAt: `2026-11-02T0${i}:00:00.000Z` });
      addRun(db, { id: "old", decision: "HOLD", total: 5, finishedAt: "2026-10-30T00:00:00.000Z" });
      addRun(db, { id: "ok", decision: "APPROVE", total: 7, finishedAt: "2026-11-02T05:00:00.000Z" });
      const v = buildSummaryVars(db, FIXED_NOW, { window_hours: 24, decisions: ["HOLD"], max_items: 2 });
      t.eq([v["summary.count"], v["summary.total_value"], v["summary.window_hours"]], [4, 1000, 24]);
      t.eq(v["summary.list"], "INV-4, Globex Logistics Ltd, $400.00: Reason 4.\nINV-3, Globex Logistics Ltd, $300.00: Reason 3.\n…and 2 more");
      db.prepare("INSERT INTO run_reviews (id, run_id, action, comment, po_number, previous_decision, created_at) VALUES ('rv', 'h4', 'REJECT', 'Not ours, rejected.', NULL, 'HOLD', ?)").run(FIXED_NOW.toISOString());
      t.eq(buildSummaryVars(db, FIXED_NOW, { window_hours: 24, decisions: ["HOLD"], max_items: 10 })["summary.count"], 3, "h4 was rejected by a person");
      t.eq(buildSummaryVars(db, FIXED_NOW, { window_hours: 24, decisions: ["HOLD", "APPROVE"], max_items: 10 })["summary.count"], 4);
      const none = buildSummaryVars(db, FIXED_NOW, { window_hours: 1, decisions: ["REJECT"], max_items: 10 });
      t.eq([none["summary.count"], none["summary.list"], none["summary.total_value"]], [0, "", 0]);
    } finally {
      db.close();
    }
  });

  await t.test("A4: chat and webhook steps: a test shows a preview and sends nothing; live sends the escaped text and the JSON envelope", async () => {
    const db = openSeededMemoryDb();
    try {
      const stub = stubSender({ bodyText: "ok" });
      const deps = depsFor(db, { send: stub.send, baseUrl: "https://ap.example.com" });
      const chat = workflowBySeed(db, "chat-rejections");
      setUrl(db, chat.id, "chat", "https://hooks.example.com/T000/B000/abcd", "s3cret");
      db.prepare("UPDATE workflows SET enabled = 1 WHERE id = ?").run(chat.id);
      addRun(db, { id: "rj", decision: "REJECT", total: 400, invoiceNumber: "INV-0042", vendorName: "<https://evil.example|Click> & co", reasons: ["Duplicate of INV-0042."] });
      const test = startTestExecution(deps, chat.id, "rj", false);
      await automationsIdle();
      t.eq(stub.calls.length, 0, "a test does not send");
      if (!test.ok) throw new Error("did not start");
      const preview = JSON.parse(stepsOf(db, test.executionId).find((x) => x.node_id === "chat")?.output ?? "null").preview;
      t.eq(preview.host, "hooks.example.com");
      dispatchRunFinished(deps, "rj");
      await automationsIdle();
      const call = only(stub.calls, "send");
      t.eq(call.req.url, "https://hooks.example.com/T000/B000/abcd");
      t.eq(call.req.signingSecret, "s3cret");
      t.eq(call.allowedHosts, ["hooks.example.com"]);
      t.eq(JSON.parse(call.req.body), { text: "Rejected: &lt;https://evil.example|Click&gt; &amp; co INV-0042 ($400.00). Duplicate of INV-0042. https://ap.example.com/runs/rj" }, "the invoice's text cannot inject a link or a mention");
      const live = only(executionsForRun(db, "rj").filter((x) => x.mode === "live"), "live execution");
      const step = stepsOf(db, live.id).find((x) => x.node_id === "chat");
      t.eq([live.status, step?.attempts, JSON.parse(step?.output ?? "null")], ["success", 1, { host: "hooks.example.com", status: 200, response: "ok" }]);
      // a webhook: the envelope is JSON built as an object, never as text
      const hook: Graph = { nodes: [node("start", "trigger.run_finished", "Start", 0, 0, { decisions: ["REJECT"], include_errors: false }), node("hook", "action.webhook", "Hook", 280, 0, { fields: [{ key: "vendor", value: "{{run.vendor_name}}" }, { key: "decision", value: "{{run.decision}}" }] })], edges: [edge("start", "out", "hook")] };
      const route = workflowBySeed(db, "route-holds");
      db.prepare("UPDATE workflows SET graph = ?, enabled = 1 WHERE id = ?").run(JSON.stringify(hook), route.id);
      setUrl(db, route.id, "hook", "https://hooks.example.com/in/xyz9");
      addRun(db, { id: "rj2", decision: "REJECT", vendorName: 'Evil "quote" \\ \n', invoiceNumber: "INV-2" });
      dispatchRunFinished(deps, "rj2");
      await automationsIdle();
      const hookCall = stub.calls.filter((c) => c.req.url === "https://hooks.example.com/in/xyz9").pop();
      t.ok(hookCall !== undefined, "the webhook step sent (the chat automation sent too, to its own URL)");
      const sent = JSON.parse((hookCall as (typeof stub.calls)[number]).req.body);
      t.eq([sent.event, sent.automation, sent.sent_at, sent.data], ["invoice.decided", { id: route.id, name: route.name }, FIXED_NOW.toISOString(), { vendor: 'Evil "quote" \\ \n', decision: "REJECT" }]);
      t.ok(typeof sent.execution_id === "string");
      t.eq((hookCall as (typeof stub.calls)[number]).req.signingSecret, null);
    } finally {
      db.close();
    }
  });

  await t.test("A4: sending needs a URL, a live workflow and room under the hourly limit; a send with sending off is refused by the sender", async () => {
    const db = openSeededMemoryDb();
    const real = CONFIG.automationMaxSendsPerHour;
    try {
      const stub = stubSender();
      const deps = depsFor(db, { send: stub.send });
      const chat = workflowBySeed(db, "chat-rejections");
      db.prepare("UPDATE workflows SET enabled = 1 WHERE id = ?").run(chat.id);
      addRun(db, { id: "a", decision: "REJECT", total: 1 });
      dispatchRunFinished(deps, "a");
      await automationsIdle();
      const noUrl = only(executionsForRun(db, "a"), "execution");
      t.eq([noUrl.status, stepsOf(db, noUrl.id).find((x) => x.node_id === "chat")?.error, stub.calls.length], ["error", "No webhook URL is set for this step.", 0]);
      // the real sender with an empty allow-list: refused before any lookup, one attempt recorded
      setUrl(db, chat.id, "chat", "https://hooks.example.com/T000/B000/abcd");
      addRun(db, { id: "b", decision: "REJECT", total: 1 });
      dispatchRunFinished(depsFor(db, { send: sendHttps, allowedHosts: [] }), "b");
      await automationsIdle();
      const refused = stepsOf(db, only(executionsForRun(db, "b"), "execution").id).find((x) => x.node_id === "chat");
      t.eq([refused?.status, refused?.error, refused?.attempts], ["error", "Sending to other servers is turned off on this server (AUTOMATION_ALLOWED_HOSTS is empty).", 1]);
      // the hourly sends cap counts attempts
      (CONFIG as { automationMaxSendsPerHour: number }).automationMaxSendsPerHour = 1;
      addRun(db, { id: "c", decision: "REJECT", total: 1 });
      dispatchRunFinished(deps, "c");
      await automationsIdle();
      t.eq(stepsOf(db, only(executionsForRun(db, "c"), "execution").id).find((x) => x.node_id === "chat")?.error, "Skipped: the limit of 1 sends an hour was reached.");
      t.eq(stub.calls.length, 0, "the stub never ran");
      // a deleted automation's step cannot send
      deleteWorkflow(db, chat.id);
    } finally {
      (CONFIG as { automationMaxSendsPerHour: number }).automationMaxSendsPerHour = real;
      db.close();
    }
  });

  await t.test("A4: retries: 503, 503, 200 is three attempts after sleeps of 1 s and 4 s; a 400 is one attempt; three retryable answers fail after three", async () => {
    const db = openSeededMemoryDb();
    try {
      const chat = workflowBySeed(db, "chat-rejections");
      setUrl(db, chat.id, "chat", "https://hooks.example.com/T000/B000/abcd");
      db.prepare("UPDATE workflows SET enabled = 1 WHERE id = ?").run(chat.id);
      const run = async (id: string, ...answers: Partial<OutboundResponse>[]) => {
        const stub = stubSender(...answers);
        const deps = depsFor(db, { send: stub.send });
        addRun(db, { id, decision: "REJECT", total: 1 });
        dispatchRunFinished(deps, id);
        await automationsIdle();
        const ex = only(executionsForRun(db, id), "execution");
        const step = stepsOf(db, ex.id).find((x) => x.node_id === "chat");
        return { status: ex.status, attempts: step?.attempts, error: step?.error, sleeps: deps.sleeps, calls: stub.calls.length };
      };
      const retry = { ok: false, status: 503, retryable: true, error: "The webhook answered 503." };
      t.eq(await run("r1", retry, retry, {}), { status: "success", attempts: 3, error: null, sleeps: [1000, 4000], calls: 3 });
      t.eq(await run("r2", { ok: false, status: 400, retryable: false, error: "The webhook answered 400." }), { status: "error", attempts: 1, error: "The webhook answered 400.", sleeps: [], calls: 1 });
      t.eq(await run("r3", retry), { status: "error", attempts: 3, error: "The webhook answered 503.", sleeps: [1000, 4000], calls: 3 });
    } finally {
      db.close();
    }
  });

  await t.test("A4: more than the hourly number of executions are recorded as skipped and not queued", async () => {
    const db = openSeededMemoryDb();
    const real = CONFIG.automationMaxExecutionsPerHour;
    try {
      (CONFIG as { automationMaxExecutionsPerHour: number }).automationMaxExecutionsPerHour = 1;
      const deps = depsFor(db);
      addRun(db, { id: "r1", decision: "HOLD", total: 10 });
      addRun(db, { id: "r2", decision: "HOLD", total: 10 });
      dispatchRunFinished(deps, "r1");
      dispatchRunFinished(deps, "r2");
      await automationsIdle();
      const second = only(executionsForRun(db, "r2"), "execution");
      t.eq([second.status, second.error, stepsOf(db, second.id).length], ["error", "Skipped: the limit of 1 automation runs an hour was reached.", 0]);
      t.eq(assignmentForRun(db, "r2"), null, "it never ran");
      t.eq(only(executionsForRun(db, "r1"), "execution").status, "success");
      t.eq(startTestExecution(deps, workflowBySeed(db, "route-holds").id, "r1", false), { ok: false, status: 409, error: "The limit of 1 automation runs an hour was reached. Try again later." }, "a test counts too");
    } finally {
      (CONFIG as { automationMaxExecutionsPerHour: number }).automationMaxExecutionsPerHour = real;
      db.close();
    }
  });

  await t.test("A4: a reset while an execution is working stops it before it writes; pausing makes dispatch record nothing; AUTOMATIONS_ENABLED=false stops dispatch", async () => {
    const db = openSeededMemoryDb();
    try {
      // an execution held in a slow send, then a reset happens (the generation moves on)
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow: AutomationDeps["send"] = async () => {
        await gate;
        return { ok: true, status: 200, bodyText: "ok", error: null, retryable: false };
      };
      const hook: Graph = {
        nodes: [
          node("start", "trigger.run_finished", "Start", 0, 0, { decisions: ["REJECT"], include_errors: false }),
          node("chat", "action.chat", "Chat", 280, 0, { text: "hi" }),
          node("note", "action.note", "Note", 560, 0, { text: "after the send" }),
        ],
        edges: [edge("start", "out", "chat"), edge("chat", "out", "note")],
      };
      const w = workflowBySeed(db, "chat-rejections");
      db.prepare("UPDATE workflows SET graph = ?, enabled = 1 WHERE id = ?").run(JSON.stringify(hook), w.id);
      setUrl(db, w.id, "chat", "https://hooks.example.com/T000/B000/abcd");
      addRun(db, { id: "rj", decision: "REJECT", total: 1 });
      dispatchRunFinished(depsFor(db, { send: slow }), "rj");
      await new Promise((resolve) => setImmediate(resolve));
      bumpAutomationGeneration(); // what the reset route does inside its exclusive section
      release();
      await automationsIdle();
      t.eq(notesForRun(db, "rj").length, 0, "no note after the reset");
      t.eq(stepsOf(db, only(executionsForRun(db, "rj"), "execution").id).filter((x) => x.node_id === "note").length, 0, "and no step for it");
      // paused: nothing is recorded
      const resume = await pauseAutomations(50);
      addRun(db, { id: "p1", decision: "HOLD", total: 1 });
      dispatchRunFinished(depsFor(db), "p1");
      await automationsIdle();
      t.eq(executionsForRun(db, "p1").length, 0, "paused");
      resume();
      dispatchRunFinished(depsFor(db), "p1");
      await automationsIdle();
      t.eq(executionsForRun(db, "p1").length, 1, "resumed");
      // switched off
      const was = process.env.AUTOMATIONS_ENABLED;
      process.env.AUTOMATIONS_ENABLED = "false";
      try {
        addRun(db, { id: "p2", decision: "HOLD", total: 1 });
        dispatchRunFinished(depsFor(db), "p2");
        await automationsIdle();
        t.eq(executionsForRun(db, "p2").length, 0, "AUTOMATIONS_ENABLED=false");
      } finally {
        if (was === undefined) delete process.env.AUTOMATIONS_ENABLED;
        else process.env.AUTOMATIONS_ENABLED = was;
      }
    } finally {
      db.close();
    }
  });

  await t.test("A4: a step that throws is recorded as a fixed sentence, and the steps after it are skipped", async () => {
    const db = openSeededMemoryDb();
    try {
      const deps = depsFor(db, { send: () => Promise.reject(new Error("secret.example.com exploded")) });
      const chat = workflowBySeed(db, "chat-rejections");
      setUrl(db, chat.id, "chat", "https://hooks.example.com/T000/B000/abcd");
      db.prepare("UPDATE workflows SET enabled = 1 WHERE id = ?").run(chat.id);
      addRun(db, { id: "rj", decision: "REJECT", total: 1 });
      dispatchRunFinished(deps, "rj");
      await automationsIdle();
      const ex = only(executionsForRun(db, "rj"), "execution");
      const step = stepsOf(db, ex.id).find((x) => x.node_id === "chat");
      t.eq([ex.status, step?.status, step?.error], ["error", "error", "This step failed unexpectedly."]);
      t.ok(!JSON.stringify(stepsOf(db, ex.id)).includes("exploded"), "the exception text is never stored");
    } finally {
      db.close();
    }
  });

  /* ---------------------------------------------------------------------------- A5: the safe sender */

  await t.test("A5: allow-list matching: an exact name, *.suffix for subdomains only, a trailing dot and upper case normalised", () => {
    t.eq(hostAllowed("hooks.slack.com", ["hooks.slack.com"]), true);
    t.eq(hostAllowed("hooks.slack.com", ["*.slack.com"]), true);
    t.eq(hostAllowed("evilslack.com", ["*.slack.com"]), false, "the dot is part of the suffix");
    t.eq(hostAllowed("slack.com", ["*.slack.com"]), false, "the bare domain is not a subdomain");
    t.eq(hostAllowed("a.b.slack.com", ["*.slack.com"]), true);
    t.eq(hostAllowed("hooks.slack.com", ["HOOKS.SLACK.COM."]), true, "the entry is normalised too");
    t.eq(hostAllowed("hooks.slack.com", []), false);
    t.eq(hostAllowed("hooks.slack.com", ["", "  "]), false);
  });

  await t.test("A5: every private, loopback, link-local, mapped, 6to4 and Teredo address is refused; public ones pass", () => {
    for (const a of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fd00::1", "fe80::1", "2002:c0a8:1::1", "2001::1", "2001:db8::1", "ff02::1", "::ffff:192.168.0.1", "::ffff:7f00:1", "64:ff9b::808:808", "not an ip"]) {
      t.eq(isBlockedAddress(a), true, a);
    }
    for (const a of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) t.eq(isBlockedAddress(a), false, a);
  });

  await t.test("A5: refusals happen before any lookup or connection, each with its fixed sentence", async () => {
    const fake = fakeHttps();
    const dns = publicResolve();
    const send = (url: string, allowed: readonly string[] = ["hooks.example.com"], resolve = dns.resolve) => sendHttps(outbound(url), allowed, resolve, fake.request);
    const refused = async (url: string, error: string, allowed?: readonly string[], resolve?: typeof dns.resolve) => {
      const r = await send(url, allowed, resolve);
      t.eq([r.ok, r.status, r.retryable, r.error, r.bodyText], [false, 0, false, error, ""], url);
    };
    await refused("not a url", "The webhook URL is not a valid URL.");
    await refused("http://hooks.example.com/x", "Only https:// webhook URLs are allowed.");
    await refused("https://user:pw@hooks.example.com/x", "The webhook URL must not contain a user name or password.");
    await refused("https://hooks.example.com:8443/x", "Only the standard https port (443) is allowed.");
    await refused("https://hooks.example.com/x", "Sending to other servers is turned off on this server (AUTOMATION_ALLOWED_HOSTS is empty).", []);
    await refused("https://other.example.com/x", "other.example.com is not in this server's list of allowed webhook hosts.");
    await refused("https://evilexample.com/x", "evilexample.com is not in this server's list of allowed webhook hosts.", ["*.example.com"]);
    await refused("https://2130706433/x", "The webhook host points to a private or reserved address.", ["hooks.example.com"]);
    await refused("https://0x7f.1/x", "The webhook host points to a private or reserved address.");
    await refused("https://[::1]/x", "The webhook host points to a private or reserved address.");
    await refused("https://127.0.0.1/x", "The webhook host points to a private or reserved address.", []);
    await refused("https://93.184.216.34/x", "93.184.216.34 is not in this server's list of allowed webhook hosts.");
    t.eq(dns.calls, [], "an address written in the URL is judged without any lookup");
    t.eq(fake.calls.length, 0, "no connection for any refusal");
    for (const bad of [["10.0.0.5"], ["::1"], ["::ffff:192.168.0.1"], ["169.254.169.254"], ["fd00::1"], ["2002:c0a8:1::1"], ["2001::1"], ["8.8.8.8", "10.0.0.5"]]) {
      const resolver = publicResolve(bad.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
      await refused("https://hooks.example.com/x", "The webhook host points to a private or reserved address.", ["hooks.example.com"], resolver.resolve);
    }
    const gone = await send("https://hooks.example.com/x", ["hooks.example.com"], () => Promise.reject(new Error("ENOTFOUND")));
    t.eq(gone.error, "The webhook host could not be found.");
    t.eq((await send("https://hooks.example.com/x", ["hooks.example.com"], () => Promise.resolve([]))).error, "The webhook host could not be found.");
    t.eq(fake.calls.length, 0, "still no connection");
  });

  await t.test("A5: a public answer connects once, to the vetted address, with the host as server name, and both signature headers", async () => {
    const fake = fakeHttps({ status: 200, body: "ok" });
    const dns = publicResolve([{ address: "8.8.8.8", family: 4 }]);
    const r = await sendHttps(outbound("https://HOOKS.example.com./T0/B0/xyz?a=1", { signingSecret: "s3cret" }), ["hooks.example.com"], dns.resolve, fake.request);
    t.eq([r.ok, r.status, r.bodyText, r.error], [true, 200, "ok", null]);
    const call = only(fake.calls, "request");
    t.eq([call.options.hostname, call.options.servername, call.options.path, call.options.port, call.options.method, call.options.autoSelectFamily], ["hooks.example.com", "hooks.example.com", "/T0/B0/xyz?a=1", 443, "POST", false]);
    t.eq(dns.calls, ["hooks.example.com"]);
    const lookup = call.options.lookup as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void;
    const all: unknown[][] = [];
    lookup("hooks.example.com", { all: true }, (...a) => all.push(a));
    t.eq(all, [[null, [{ address: "8.8.8.8", family: 4 }]]], "the vetted address, in the array form");
    const one: unknown[][] = [];
    lookup("hooks.example.com", {}, (...a) => one.push(a));
    t.eq(one, [[null, "8.8.8.8", 4]], "and in the single form; a changed DNS answer is never used");
    const headers = call.options.headers as Record<string, string | number>;
    t.eq([headers["content-type"], headers["user-agent"], headers["content-length"], headers["x-invoice-ap-timestamp"]], ["application/json", "invoice-ap-automations/1", 13, "1700000000"]);
    t.eq(headers["x-invoice-ap-signature"], `sha256=${crypto.createHmac("sha256", "s3cret").update('1700000000.{"text":"hi"}').digest("hex")}`);
    t.eq(call.written, ['{"text":"hi"}']);
    const unsigned = fakeHttps();
    await sendHttps(outbound("https://hooks.example.com/x"), ["*.example.com"], dns.resolve, unsigned.request);
    t.ok(!("x-invoice-ap-signature" in (unsigned.calls[0].options.headers as object)), "no secret, no signature");
    t.eq(signPayload("s3cret", 1_700_000_000, "{}"), `sha256=${crypto.createHmac("sha256", "s3cret").update("1700000000.{}").digest("hex")}`);
    const literal = fakeHttps();
    const nodns = publicResolve();
    const lit = await sendHttps(outbound("https://93.184.216.34/x"), ["93.184.216.34"], nodns.resolve, literal.request);
    t.eq([lit.ok, nodns.calls.length, literal.calls[0].options.hostname], [true, 0, "93.184.216.34"], "a public literal that was allowed on purpose connects without a lookup");
  });

  await t.test("A5: answers: 2xx is ok, a redirect is refused, 429 and 5xx retry, other 4xx do not; the body is cut and cleaned", async () => {
    const dns = publicResolve();
    const answer = async (script: FakeScript) => sendHttps(outbound("https://hooks.example.com/x"), ["hooks.example.com"], dns.resolve, fakeHttps(script).request);
    for (const [status, ok, retryable, error] of [
      [200, true, false, null],
      [204, true, false, null],
      [301, false, false, "The webhook answered with a redirect, which is not followed."],
      [302, false, false, "The webhook answered with a redirect, which is not followed."],
      [400, false, false, "The webhook answered 400."],
      [404, false, false, "The webhook answered 404."],
      [429, false, true, "The webhook answered 429."],
      [500, false, true, "The webhook answered 500."],
      [503, false, true, "The webhook answered 503."],
    ] as const) {
      const r = await answer({ status });
      t.eq([r.ok, r.status, r.retryable, r.error], [ok, status, retryable, error], String(status));
    }
    const cleaned = await answer({ body: `a\u0000b\u0007c${"x".repeat(1000)}` });
    t.eq(cleaned.bodyText.length, CONFIG.automationResponseKeepChars, "only a few hundred characters are kept");
    t.ok(cleaned.bodyText.startsWith("abcxxx"), "control characters removed");
    const huge = await answer({ bodyBytes: 200_000 });
    t.eq([huge.ok, huge.bodyText.length], [true, CONFIG.automationResponseKeepChars], "a huge answer is cut at 64 KB and answered once");
    const net = await answer({ networkError: true });
    t.eq([net.ok, net.status, net.retryable, net.error], [false, 0, true, "The webhook could not be reached."]);
    t.ok(!JSON.stringify(net).includes("secret.example.com"), "the exception text (which can echo the host) is never kept");
  });

  await t.test("A5: the whole attempt has a deadline: a server that never finishes is cut off, and it is retryable", async () => {
    const real = CONFIG.automationStepTimeoutMs;
    (CONFIG as { automationStepTimeoutMs: number }).automationStepTimeoutMs = 50;
    try {
      const fake = fakeHttps({ neverEnds: true });
      const r = await sendHttps(outbound("https://hooks.example.com/x"), ["hooks.example.com"], publicResolve().resolve, fake.request);
      t.eq([r.ok, r.status, r.retryable, r.error], [false, 0, true, "The webhook did not answer within 10 seconds."]);
      t.eq(fake.calls[0].destroyedWith.length, 1, "the connection was destroyed");
    } finally {
      (CONFIG as { automationStepTimeoutMs: number }).automationStepTimeoutMs = real;
    }
  });

  /* ---------------------------------------------------------------------------- A12: the scheduler */

  await t.test("A12: latestSlot: a day schedule gives today's time or yesterday's, an hour schedule this hour's minute or the previous hour's", () => {
    const day: ScheduleConfig = { every: "day", hour: 8, minute: 0 };
    const at = (iso: string) => new Date(iso);
    t.eq(latestSlot(day, at("2026-11-02T07:59:00.000Z")).toISOString(), "2026-11-01T08:00:00.000Z", "before 08:00: yesterday");
    t.eq(latestSlot(day, at("2026-11-02T08:00:00.000Z")).toISOString(), "2026-11-02T08:00:00.000Z", "at 08:00: today");
    t.eq(latestSlot(day, at("2026-11-02T23:59:59.999Z")).toISOString(), "2026-11-02T08:00:00.000Z");
    t.eq(latestSlot(day, at("2026-01-01T00:00:00.000Z")).toISOString(), "2025-12-31T08:00:00.000Z", "across a year");
    t.eq(latestSlot({ every: "day", hour: 23, minute: 45 }, at("2026-03-01T10:00:00.000Z")).toISOString(), "2026-02-28T23:45:00.000Z", "across a month");
    const hour: ScheduleConfig = { every: "hour", hour: 0, minute: 15 };
    t.eq(latestSlot(hour, at("2026-11-02T10:14:00.000Z")).toISOString(), "2026-11-02T09:15:00.000Z");
    t.eq(latestSlot(hour, at("2026-11-02T10:15:00.000Z")).toISOString(), "2026-11-02T10:15:00.000Z");
    t.eq(latestSlot(hour, at("2026-11-02T00:10:00.000Z")).toISOString(), "2026-11-01T23:15:00.000Z", "across midnight");
  });

  await t.test("A12: a tick starts an enabled schedule automation once per slot, never for a slot before it was turned on, never a storm after downtime, and not when it is off", async () => {
    const db = openSeededMemoryDb();
    try {
      let clock = new Date("2026-11-02T08:30:00.000Z");
      const deps = depsFor(db, { now: () => clock });
      const daily = workflowBySeed(db, "daily-holds");
      const executionsOf = () => listExecutions(db, daily.id, 50).map((e) => e.trigger_key).sort();
      t.eq(tickSchedules(deps), 0, "off: nothing");
      setEnabled(db, daily.id, true, "2026-11-02T08:10:00.000Z");
      t.eq(tickSchedules(deps), 0, "its latest slot (08:00) is before it was turned on (08:10)");
      clock = new Date("2026-11-03T08:00:30.000Z");
      t.eq(tickSchedules(deps), 1, "the 08:00 slot of the next day");
      await automationsIdle();
      t.eq(tickSchedules(deps), 0, "a second tick in the same slot does nothing");
      clock = new Date("2026-11-03T20:00:00.000Z");
      t.eq(tickSchedules(deps), 0, "still the same slot");
      t.eq(executionsOf(), ["schedule:2026-11-03T08:00:00.000Z"]);
      const ex = listExecutions(db, daily.id, 1)[0];
      t.eq([ex.status, ex.trigger_type, ex.mode, ex.run_id, JSON.parse(ex.vars)["now.date"]], ["success", "schedule", "live", null, "2026-11-03"]);
      // five days of downtime: one execution for the latest slot, not five
      clock = new Date("2026-11-08T09:00:00.000Z");
      t.eq(tickSchedules(deps), 1);
      await automationsIdle();
      t.eq(executionsOf(), ["schedule:2026-11-03T08:00:00.000Z", "schedule:2026-11-08T08:00:00.000Z"], "only the latest slot ran");
      // turned off: nothing
      setEnabled(db, daily.id, false, clock.toISOString());
      clock = new Date("2026-11-09T09:00:00.000Z");
      t.eq(tickSchedules(deps), 0);
      // switched off for the whole server
      setEnabled(db, daily.id, true, "2026-11-09T00:00:00.000Z");
      const was = process.env.AUTOMATIONS_ENABLED;
      process.env.AUTOMATIONS_ENABLED = "false";
      try {
        t.eq(tickSchedules(deps), 0, "AUTOMATIONS_ENABLED=false");
      } finally {
        if (was === undefined) delete process.env.AUTOMATIONS_ENABLED;
        else process.env.AUTOMATIONS_ENABLED = was;
      }
      t.eq(tickSchedules(deps), 1, "and back on");
      await automationsIdle();
    } finally {
      db.close();
    }
  });

  await t.test("A12: an hourly schedule fires once an hour at its minute; a run-triggered automation is never fired by a tick", async () => {
    const db = openSeededMemoryDb();
    try {
      let clock = new Date("2026-11-02T10:20:00.000Z");
      const deps = depsFor(db, { now: () => clock });
      const daily = workflowBySeed(db, "daily-holds");
      const graph = JSON.parse(daily.graph) as Graph;
      (graph.nodes[0].config as Record<string, unknown>) = { every: "hour", hour: 0, minute: 15 };
      db.prepare("UPDATE workflows SET graph = ? WHERE id = ?").run(JSON.stringify(graph), daily.id);
      setEnabled(db, daily.id, true, "2026-11-02T10:00:00.000Z");
      t.eq(tickSchedules(deps), 1, "10:15 is after it was turned on at 10:00");
      t.eq(tickSchedules(deps), 0);
      clock = new Date("2026-11-02T11:14:00.000Z");
      t.eq(tickSchedules(deps), 0, "11:15 has not come");
      clock = new Date("2026-11-02T11:15:00.000Z");
      t.eq(tickSchedules(deps), 1);
      await automationsIdle();
      t.eq(listExecutions(db, daily.id, 10).map((e) => e.trigger_key).sort(), ["schedule:2026-11-02T10:15:00.000Z", "schedule:2026-11-02T11:15:00.000Z"]);
      t.eq(listExecutions(db, workflowBySeed(db, "route-holds").id, 10).length, 0, "the run-triggered seed is not a schedule");
    } finally {
      db.close();
    }
  });

  /* ---------------------------------------------------------------------------- A10: graph-edit */

  await t.test("A10: addStepAfter connects from the requested output, places the step 280 px right and 140 px below a sibling, and always gives a graph the server reads", () => {
    const g = inlineSeeds().route;
    const before = JSON.stringify(g);
    const added = addStepAfter(g, "if-security", "false", "action.note");
    t.eq(JSON.stringify(g), before, "the input graph is untouched");
    t.eq(added.id, "note-1");
    const created = added.graph.nodes.find((n) => n.id === "note-1") as GraphNode;
    const sibling = g.nodes.find((n) => n.id === "if-large") as GraphNode;
    t.eq(created.position, { x: 280 + 280, y: sibling.position.y + 140 }, "right of the parent, below the previous child on that output");
    t.ok(added.graph.edges.some((e) => e.source === "if-security" && e.sourceHandle === "false" && e.target === "note-1"), "connected from the false output");
    t.ok(!added.graph.edges.some((e) => e.source === "if-security" && e.sourceHandle === "true" && e.target === "note-1"), "and not from the other one");
    t.eq([created.name, created.config], ["Add a note to the invoice", { text: "" }]);
    const first = addStepAfter(inlineSeeds().chat, "chat", "out", "action.chat");
    t.eq(first.graph.nodes.find((n) => n.id === first.id)?.position, { x: 560, y: 0 }, "the first child sits level with its parent");
    t.eq(addStepAfter(g, null, "out", "action.note").graph.edges.length, g.edges.length, "no parent: not connected");
    t.eq(addStepAfter(g, "start", "bogus", "action.note").graph.edges.length, g.edges.length, "an output the parent lacks: not connected");
    t.eq(messages(addStepAfter(addStepAfter(g, "assign-clerk", "out", "action.note").graph, "assign-lead", "out", "action.note").graph).length, 2, "two empty notes: two problems, no structural one");
    let threw = false;
    try {
      addStepAfter(g, "start", "out", "trigger.schedule");
    } catch {
      threw = true;
    }
    t.ok(threw, "a starting step is not added like this");
    const at = addStepAt(g, "action.chat", 123.6, -40.2);
    t.eq([at.graph.nodes.find((n) => n.id === at.id)?.position, at.graph.edges.length], [{ x: 124, y: -40 }, g.edges.length], "dropped at the pointer, unconnected");
  });

  await t.test("A10: connect refuses a cycle, a duplicate, a connection into the trigger, to itself, and from an output the step lacks", () => {
    const g = inlineSeeds().route;
    const ok = connect(g, "assign-clerk", "out", "note-security");
    t.ok(ok.ok && ok.graph.edges.length === g.edges.length + 1, "a new connection is made");
    const refuse = (r: ReturnType<typeof connect>, error: string, what: string) => t.eq(r.ok ? "accepted" : r.error, error, what);
    refuse(connect(g, "assign-lead", "out", "if-large"), "That connection would make the steps go round in a circle.", "cycle");
    refuse(connect(g, "if-large", "true", "if-large"), "A step cannot connect to itself.", "to itself");
    refuse(connect(g, "if-large", "true", "assign-lead"), "These two steps are already connected that way.", "duplicate");
    refuse(connect(g, "assign-lead", "out", "start"), "Nothing can lead into the starting step.", "into the trigger");
    refuse(connect(g, "assign-lead", "yes", "note-security"), "That step has no such output.", "bad output");
    refuse(connect(g, "ghost", "out", "note-security"), "That step does not exist.", "missing step");
    t.ok(connect(g, "if-large", "false", "assign-lead").ok, "the other output of the same step may lead to the same target");
    t.ok(connect(g, "assign-lead", "out", "assign-clerk").ok);
  });

  await t.test("A10: removeStep removes its connections; the starting step stays; removeEdge removes one connection", () => {
    const g = inlineSeeds().route;
    const without = removeStep(g, "if-large");
    t.eq(without.nodes.some((n) => n.id === "if-large"), false);
    t.eq(without.edges.filter((e) => e.source === "if-large" || e.target === "if-large").length, 0, "no dangling connection");
    t.eq(without.edges.length, g.edges.length - 3, "its three connections went");
    t.eq(removeStep(g, "start"), g, "the starting step cannot be removed");
    t.eq(removeStep(g, "ghost"), g);
    t.eq(removeEdge(g, "if-large-true-assign-lead").edges.length, g.edges.length - 1);
    t.eq(messages(without), ["This step is not connected to the start.", "This step is not connected to the start."], "the two steps below it are now loose");
  });

  await t.test("A10: duplicateStep copies the settings under a fresh id, 40 px right and down, connected to nothing; rename, config and position change one step", () => {
    const g = inlineSeeds().route;
    const dup = duplicateStep(g, "assign-lead");
    t.ok(dup !== null);
    if (dup === null) return;
    const copy = dup.graph.nodes.find((n) => n.id === dup.id) as GraphNode;
    t.eq([dup.id, copy.name, copy.config, copy.position], ["assign-1", "Assign to AP lead copy", { assignee: "AP lead" }, { x: 880, y: 80 }]);
    t.eq(dup.graph.edges, g.edges, "no new connection");
    (copy.config as { assignee: string }).assignee = "changed";
    t.eq((g.nodes.find((n) => n.id === "assign-lead")?.config as { assignee: string }).assignee, "AP lead", "a deep copy");
    t.eq(duplicateStep(g, "start"), null);
    t.eq(duplicateStep(g, "ghost"), null);
    t.eq(renameStep(g, "assign-lead", "  Hand to the lead ").nodes.find((n) => n.id === "assign-lead")?.name, "Hand to the lead");
    t.eq(renameStep(g, "assign-lead", "   "), g, "an empty name keeps the old one");
    t.eq(setConfig(g, "assign-lead", { assignee: "Sam" }).nodes.find((n) => n.id === "assign-lead")?.config, { assignee: "Sam" });
    t.eq(setPosition(g, "start", 1e9, -1e9).nodes[0].position, { x: 100000, y: -100000 }, "kept inside the schema's range");
  });

  await t.test("A10: replaceTrigger keeps the starting step's id, place and outgoing connections and resets its settings", () => {
    const g = inlineSeeds().route;
    const swapped = replaceTrigger(g, "trigger.schedule");
    const start = swapped.nodes.find((n) => n.id === "start") as GraphNode;
    t.eq([start.type, start.name, start.config, start.position], ["trigger.schedule", "On a schedule", { every: "day", hour: 8, minute: 0 }, { x: 0, y: 0 }]);
    t.eq(swapped.edges, g.edges, "the connections stay");
    t.eq(swapped.nodes.length, g.nodes.length);
    const none = replaceTrigger({ nodes: [], edges: [] }, "trigger.run_finished");
    t.eq([none.nodes.length, none.nodes[0].id, none.nodes[0].type], [1, "start-1", "trigger.run_finished"]);
    t.eq(messages(swapped).some((m) => m.includes("runs on a schedule")), true, "steps that need an invoice are now reported");
  });

  await t.test("A10: freeOutputs and incoming report what is not connected and what leads into a step", () => {
    const g = inlineSeeds().route;
    t.eq(freeOutputs(g, "if-large"), []);
    t.eq(freeOutputs(g, "assign-lead"), ["out"]);
    t.eq(freeOutputs(removeEdge(g, "if-large-false-assign-clerk"), "if-large"), ["false"]);
    t.eq(incoming(g, "if-large").map((i) => [i.from.id, i.edge.sourceHandle]), [["if-security", "false"]]);
    t.eq(incoming(g, "start"), []);
  });

  await t.test("A10: outlineRows draws a tree from the start under each parent's output label; loose steps come last; a step with two parents says so", () => {
    const g = inlineSeeds().route;
    const rows = outlineRows(g);
    const text = rows.map((r) => (r.kind === "label" ? `${"  ".repeat(r.depth)}${r.text}` : r.kind === "step" ? `${"  ".repeat(r.depth)}${r.number} ${r.node.id}` : `loose ${r.number} ${r.node.id}`));
    t.eq(text, [
      "1 start",
      "  2 if-security",
      "    Yes:",
      "      3 assign-security",
      "        4 note-security",
      "    No:",
      "      5 if-large",
      "        Yes:",
      "          6 assign-lead",
      "        No:",
      "          7 assign-clerk",
    ]);
    const joined = connect(g, "assign-clerk", "out", "note-security");
    if (!joined.ok) throw new Error(joined.error);
    const two = outlineRows(joined.graph).find((r) => r.kind === "step" && r.node.id === "note-security");
    t.eq(two?.kind === "step" ? two.alsoFrom : null, ["Assign to AP clerk"], "listed once, with the other parent named");
    const loose = addStepAt(g, "action.note", 600, 400).graph;
    const last = outlineRows(loose).at(-1);
    t.eq([last?.kind, last?.kind === "loose" ? last.node.id : null, last?.kind === "loose" ? last.number : null], ["loose", "note-1", 8]);
    t.eq(outlineRows({ nodes: [], edges: [] }), []);
  });
}
