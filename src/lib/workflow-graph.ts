/**
 * The shared graph module of Automations (plan A1): the catalogue of steps, their settings, the graph shape, the
 * values a step may use, and every pure helper that works on them (templates, conditions, order, validation, the
 * one-line summary of a step). Pure TypeScript: it imports only zod, the types of ./types and ./format, so the editor
 * runs the same validation in the browser that the server runs before it saves or runs an automation.
 *
 * It never touches a database, the network or the clock, and it never decides an invoice: automations only route what
 * the agent decided. Templates are `{{ name }}` from a fixed list, with no filters and no evaluation.
 */
import { z } from "zod";
import { formatUsd } from "./format";

/* ================================================================================================
 * 6.1 The catalogue
 * ============================================================================================== */

export const NODE_TYPES = [
  "trigger.run_finished",
  "trigger.review_saved",
  "trigger.schedule",
  "logic.if",
  "logic.switch_decision",
  "data.vendor",
  "data.po_balance",
  "data.summarize",
  "action.note",
  "action.assign",
  "action.webhook",
  "action.chat",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export type NodeKind = "trigger" | "logic" | "data" | "action";

/** Where a variable comes from. "run" = the invoice run; "always" = available everywhere. */
export type VarSource = "run" | "review" | "vendor" | "po" | "summary" | "always";

export interface NodeOutput {
  id: string;
  label: string;
}
export interface NodeSpec {
  type: NodeType;
  kind: NodeKind;
  /** palette and default step name, sentence case */
  label: string;
  /** one sentence for the palette's description */
  description: string;
  outputs: readonly NodeOutput[];
  /** needs an invoice run (invalid under a schedule trigger) */
  needsRun: boolean;
  /** variable namespaces this step adds for the steps after it */
  provides: readonly VarSource[];
  /** has a URL secret (webhook/chat) */
  hasUrl: boolean;
  defaultConfig: () => unknown;
}

const OUT: readonly NodeOutput[] = [{ id: "out", label: "Then" }];
const OUT_PLAIN: readonly NodeOutput[] = [{ id: "out", label: "Then" }];

export const NODE_SPECS: Readonly<Record<NodeType, NodeSpec>> = {
  "trigger.run_finished": {
    type: "trigger.run_finished",
    kind: "trigger",
    label: "When an invoice is decided",
    description: "Starts after the agent decides an invoice.",
    outputs: OUT,
    needsRun: false,
    provides: ["run"],
    hasUrl: false,
    defaultConfig: () => ({ decisions: ["HOLD"], include_errors: false }),
  },
  "trigger.review_saved": {
    type: "trigger.review_saved",
    kind: "trigger",
    label: "When a hold is resolved",
    description: "Starts after a person approves or rejects a held invoice.",
    outputs: OUT_PLAIN,
    needsRun: false,
    provides: ["run", "review"],
    hasUrl: false,
    defaultConfig: () => ({ actions: ["APPROVE", "REJECT"] }),
  },
  "trigger.schedule": {
    type: "trigger.schedule",
    kind: "trigger",
    label: "On a schedule",
    description: "Starts every hour or every day at a set time (UTC).",
    outputs: OUT_PLAIN,
    needsRun: false,
    provides: [],
    hasUrl: false,
    defaultConfig: () => ({ every: "day", hour: 8, minute: 0 }),
  },
  "logic.if": {
    type: "logic.if",
    kind: "logic",
    label: "If",
    description: "Goes one way when the conditions are met and the other way when not.",
    outputs: [
      { id: "true", label: "Yes" },
      { id: "false", label: "No" },
    ],
    needsRun: false,
    provides: [],
    hasUrl: false,
    defaultConfig: () => ({ combine: "all", conditions: [{ field: "run.decision", op: "is", value: "HOLD" }] }),
  },
  "logic.switch_decision": {
    type: "logic.switch_decision",
    kind: "logic",
    label: "Split by decision",
    description: "Goes a different way for each decision.",
    outputs: [
      { id: "APPROVE", label: "Approved" },
      { id: "HOLD", label: "On hold" },
      { id: "REJECT", label: "Rejected" },
      { id: "ERROR", label: "System error" },
    ],
    needsRun: true,
    provides: [],
    hasUrl: false,
    defaultConfig: () => ({}),
  },
  "data.vendor": {
    type: "data.vendor",
    kind: "data",
    label: "Look up the vendor",
    description: "Adds the vendor's details from the vendor master.",
    outputs: OUT,
    needsRun: true,
    provides: ["vendor"],
    hasUrl: false,
    defaultConfig: () => ({}),
  },
  "data.po_balance": {
    type: "data.po_balance",
    kind: "data",
    label: "Look up the PO balance",
    description: "Adds what is left on the invoice's purchase order.",
    outputs: OUT,
    needsRun: true,
    provides: ["po"],
    hasUrl: false,
    defaultConfig: () => ({}),
  },
  "data.summarize": {
    type: "data.summarize",
    kind: "data",
    label: "Summarize recent invoices",
    description: "Adds a count and a list of recent invoices.",
    outputs: OUT,
    needsRun: false,
    provides: ["summary"],
    hasUrl: false,
    defaultConfig: () => ({ window_hours: 24, decisions: ["HOLD"], max_items: 10 }),
  },
  "action.note": {
    type: "action.note",
    kind: "action",
    label: "Add a note to the invoice",
    description: "Writes a note on the invoice's page.",
    outputs: OUT,
    needsRun: true,
    provides: [],
    hasUrl: false,
    defaultConfig: () => ({ text: "" }),
  },
  "action.assign": {
    type: "action.assign",
    kind: "action",
    label: "Assign to someone",
    description: "Shows who should handle the invoice.",
    outputs: OUT,
    needsRun: true,
    provides: [],
    hasUrl: false,
    defaultConfig: () => ({ assignee: "" }),
  },
  "action.webhook": {
    type: "action.webhook",
    kind: "action",
    label: "Send to a webhook",
    description: "Sends the invoice's details as JSON to another system.",
    outputs: OUT,
    needsRun: false,
    provides: [],
    hasUrl: true,
    defaultConfig: () => ({ fields: [{ key: "decision", value: "{{run.decision}}" }] }),
  },
  "action.chat": {
    type: "action.chat",
    kind: "action",
    label: "Post a chat message",
    description: "Posts a message to a Slack-compatible chat webhook.",
    outputs: OUT,
    needsRun: false,
    provides: [],
    hasUrl: true,
    defaultConfig: () => ({ text: "" }),
  },
};

export const TRIGGER_TYPES = ["trigger.run_finished", "trigger.review_saved", "trigger.schedule"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const isTriggerType = (type: string): type is TriggerType => (TRIGGER_TYPES as readonly string[]).includes(type);

/* ================================================================================================
 * 6.2 Settings schemas
 * ============================================================================================== */

const DECISIONS3 = ["APPROVE", "HOLD", "REJECT"] as const;
const tmpl = (max: number) => z.string().max(max);

export const CONDITION_OPS = ["is", "is_not", "contains", "not_contains", "starts_with", "gt", "gte", "lt", "lte", "eq", "is_true", "is_false"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const ConditionSchema = z.strictObject({
  field: z.string().max(40),
  op: z.enum(CONDITION_OPS),
  value: z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const CONFIG_SCHEMAS = {
  "trigger.run_finished": z.strictObject({ decisions: z.array(z.enum(DECISIONS3)).max(3), include_errors: z.boolean() }),
  "trigger.review_saved": z.strictObject({ actions: z.array(z.enum(["APPROVE", "REJECT"])).min(1).max(2) }),
  "trigger.schedule": z.strictObject({ every: z.enum(["hour", "day"]), hour: z.int().min(0).max(23), minute: z.int().min(0).max(59) }),
  "logic.if": z.strictObject({ combine: z.enum(["all", "any"]), conditions: z.array(ConditionSchema).min(1).max(10) }),
  "logic.switch_decision": z.strictObject({}),
  "data.vendor": z.strictObject({}),
  "data.po_balance": z.strictObject({}),
  "data.summarize": z.strictObject({ window_hours: z.int().min(1).max(168), decisions: z.array(z.enum(DECISIONS3)).min(1).max(3), max_items: z.int().min(1).max(20) }),
  "action.note": z.strictObject({ text: tmpl(1000) }),
  "action.assign": z.strictObject({ assignee: z.string().max(60) }),
  "action.webhook": z.strictObject({ fields: z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), value: tmpl(2000) })).max(20) }),
  "action.chat": z.strictObject({ text: tmpl(2000) }),
} as const satisfies Record<NodeType, z.ZodType>;

/** The settings of each step type, typed. */
export type NodeConfig<T extends NodeType> = z.infer<(typeof CONFIG_SCHEMAS)[T]>;

/* ================================================================================================
 * 6.3 The graph
 * ============================================================================================== */

/** Mirror CONFIG.automationMaxNodes / automationMaxEdges (config.ts is server-only; a contracts check keeps them equal). */
export const GRAPH_MAX_NODES = 30;
export const GRAPH_MAX_EDGES = 60;

export const NodeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
export const GraphNodeSchema = z.strictObject({
  id: NodeIdSchema,
  type: z.enum(NODE_TYPES),
  name: z.string().min(1).max(60),
  position: z.strictObject({ x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000) }),
  config: z.record(z.string(), z.unknown()), // checked per type by validateGraph, so one bad step does not hide the rest
});
export const GraphEdgeSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}$/),
  source: NodeIdSchema,
  sourceHandle: z.string().max(20),
  target: NodeIdSchema,
});
export const GraphSchema = z.strictObject({
  nodes: z.array(GraphNodeSchema).max(GRAPH_MAX_NODES),
  edges: z.array(GraphEdgeSchema).max(GRAPH_MAX_EDGES),
});
export type Graph = z.infer<typeof GraphSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/* ================================================================================================
 * 6.4 Values a step may use
 * ============================================================================================== */

export type VarType = "text" | "money" | "count" | "yesno" | "decision" | "review_action" | "datetime";
export interface VarSpec {
  type: VarType;
  source: VarSource;
  label: string;
}
export const VARIABLES = {
  "run.id": { type: "text", source: "run", label: "Run id" },
  "run.url": { type: "text", source: "run", label: "Link to the invoice's page" },
  "run.file_name": { type: "text", source: "run", label: "File name" },
  "run.decision": { type: "decision", source: "run", label: "Decision (APPROVE, HOLD, REJECT, or empty for a system error)" },
  "run.decision_text": { type: "text", source: "run", label: "Decision in words (Approved, On hold, Rejected, System error)" },
  "run.reasons": { type: "text", source: "run", label: 'All reasons, joined with "; "' },
  "run.first_reason": { type: "text", source: "run", label: "The first reason" },
  "run.next_action": { type: "text", source: "run", label: "Next action" },
  "run.security_flag": { type: "yesno", source: "run", label: "Security flag" },
  "run.bank_change": { type: "yesno", source: "run", label: "New or different bank details" },
  "run.vendor_id": { type: "text", source: "run", label: "Vendor id" },
  "run.vendor_name": { type: "text", source: "run", label: "Vendor name" },
  "run.invoice_number": { type: "text", source: "run", label: "Invoice number" },
  "run.invoice_date": { type: "text", source: "run", label: "Invoice date" },
  "run.total": { type: "money", source: "run", label: "Total" },
  "run.po_number": { type: "text", source: "run", label: "PO number" },
  "run.po_inferred": { type: "yesno", source: "run", label: "PO was inferred" },
  "run.finished_at": { type: "datetime", source: "run", label: "Finished at" },
  "review.action": { type: "review_action", source: "review", label: "Review outcome" },
  "review.comment": { type: "text", source: "review", label: "Review comment" },
  "vendor.name": { type: "text", source: "vendor", label: "Vendor name (master)" },
  "vendor.approved": { type: "yesno", source: "vendor", label: "Vendor is approved" },
  "vendor.phone_on_file": { type: "text", source: "vendor", label: "Vendor phone on file" },
  "po.number": { type: "text", source: "po", label: "PO number" },
  "po.subtotal": { type: "money", source: "po", label: "PO value" },
  "po.remaining": { type: "money", source: "po", label: "Left on the PO" },
  "po.status": { type: "text", source: "po", label: "PO status" },
  "summary.count": { type: "count", source: "summary", label: "Number of invoices" },
  "summary.total_value": { type: "money", source: "summary", label: "Their total value" },
  "summary.list": { type: "text", source: "summary", label: "One line per invoice" },
  "summary.window_hours": { type: "count", source: "summary", label: "Hours covered" },
  "now.date": { type: "text", source: "always", label: "Today's date (UTC)" },
  "workflow.name": { type: "text", source: "always", label: "This automation's name" },
} as const satisfies Record<string, VarSpec>;
export type VarName = keyof typeof VARIABLES;
export type VarValue = string | number | boolean | null;
export type Vars = Partial<Record<VarName, VarValue>>;
// No bank account, raw model output or suspicious_content is ever a variable.

export const isVarName = (name: string): name is VarName => Object.prototype.hasOwnProperty.call(VARIABLES, name);

/** The operators each kind of value allows (a date cannot be used in a condition). */
export const OPS_BY_TYPE: Readonly<Record<VarType, readonly ConditionOp[]>> = {
  text: ["is", "is_not", "contains", "not_contains", "starts_with"],
  decision: ["is", "is_not"],
  review_action: ["is", "is_not"],
  money: ["gt", "gte", "lt", "lte", "eq"],
  count: ["gt", "gte", "lt", "lte", "eq"],
  yesno: ["is_true", "is_false"],
  datetime: [],
};

/** The words for an operator in a sentence ("Total is more than $5,000"). */
export const OP_WORDS: Readonly<Record<ConditionOp, string>> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  eq: "equals",
  is_true: "is yes",
  is_false: "is no",
};

/** The words for a decision or a review outcome. */
export const DECISION_WORDS: Readonly<Record<string, string>> = { APPROVE: "Approved", HOLD: "On hold", REJECT: "Rejected" };

/* ================================================================================================
 * 6.5 Pure helpers
 * ============================================================================================== */

const TOKEN = /\{\{\s*([a-z_]+(?:\.[a-z_]+)+)\s*\}\}/g;
/** The {{name}} pattern, for the editor's preview (global: use with String.replace, which resets it). */
export const TEMPLATE_TOKEN = TOKEN;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Every {{name}} in a template, in order, duplicates removed. */
export function templateVars(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(TOKEN)) seen.add(m[1]);
  return [...seen];
}

function showValue(name: VarName, value: VarValue): string {
  if (value === null) return "";
  switch (VARIABLES[name].type) {
    case "money":
      return typeof value === "number" && Number.isFinite(value) ? formatUsd(value) : "";
    case "count":
      return String(value);
    case "yesno":
      return value === true ? "yes" : value === false ? "no" : "";
    default:
      return String(value).replace(CONTROL, "");
  }
}

const SLACK_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/**
 * Replaces each {{name}} with its value. money -> formatUsd, count -> String(n), yesno -> "yes"/"no", null -> "" (not
 * available), text -> control characters (U+0000-U+001F except \n and \t, and U+007F-U+009F) removed. escape "slack":
 * in substituted VALUES only (never in the author's own text), & < > become entities, so an invoice cannot inject a link
 * or a mention. A name that is not in `vars` (absent key) is replaced with "" and listed in `missing`.
 */
export function renderTemplate(template: string, vars: Vars, escape: "none" | "slack"): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(TOKEN, (_all, name: string) => {
    if (!isVarName(name) || !Object.prototype.hasOwnProperty.call(vars, name) || vars[name] === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    const shown = showValue(name, vars[name] as VarValue);
    return escape === "slack" ? shown.replace(/[&<>]/g, (c) => SLACK_ESCAPES[c]) : shown;
  });
  return { text, missing };
}

/** One condition. A var that is absent or null makes every op false except is_not / not_contains (true) and is_false (true for null). */
export function evaluateCondition(c: Condition, vars: Vars): boolean {
  const v = isVarName(c.field) ? vars[c.field] : undefined;
  if (v === undefined || v === null) return c.op === "is_not" || c.op === "not_contains" || c.op === "is_false";
  const exact = isVarName(c.field) && (VARIABLES[c.field].type === "decision" || VARIABLES[c.field].type === "review_action");
  const norm = (x: unknown): string => String(x).trim().toLowerCase();
  const same = exact ? String(v) === String(c.value) : norm(v) === norm(c.value);
  switch (c.op) {
    case "is":
      return same;
    case "is_not":
      return !same;
    case "contains":
      return norm(v).includes(norm(c.value));
    case "not_contains":
      return !norm(v).includes(norm(c.value));
    case "starts_with":
      return norm(v).startsWith(norm(c.value));
    case "gt":
      return typeof v === "number" && typeof c.value === "number" && v > c.value;
    case "gte":
      return typeof v === "number" && typeof c.value === "number" && v >= c.value;
    case "lt":
      return typeof v === "number" && typeof c.value === "number" && v < c.value;
    case "lte":
      return typeof v === "number" && typeof c.value === "number" && v <= c.value;
    case "eq":
      return typeof v === "number" && typeof c.value === "number" && v === c.value;
    case "is_true":
      return v === true;
    case "is_false":
      return v === false;
  }
}

/** Kahn's algorithm; ties broken by node position (y, then x, then id) so the order is stable. null when there is a cycle. */
export function topoOrder(graph: Graph): string[] | null {
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const indegree = new Map<string, number>([...byId.keys()].map((id) => [id, 0]));
  const next = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  }
  const rank = (a: string, b: string): number => {
    const na = byId.get(a) as GraphNode;
    const nb = byId.get(b) as GraphNode;
    return na.position.y - nb.position.y || na.position.x - nb.position.x || (a < b ? -1 : a > b ? 1 : 0);
  };
  const ready = [...indegree].filter(([, d]) => d === 0).map(([id]) => id).sort(rank);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const t of next.get(id) ?? []) {
      const d = (indegree.get(t) ?? 0) - 1;
      indegree.set(t, d);
      if (d === 0) {
        ready.push(t);
        ready.sort(rank);
      }
    }
  }
  return order.length === byId.size ? order : null;
}

/** The trigger node (the first one in the list), or null. */
export function triggerOf(graph: Graph): GraphNode | null {
  return graph.nodes.find((n) => isTriggerType(n.type)) ?? null;
}

/** Ids reachable from the trigger by following connections (the trigger included). */
function reachableFrom(graph: Graph, start: string): Set<string> {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const e of graph.edges) if (ids.has(e.source) && ids.has(e.target)) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const t of out.get(queue.shift() as string) ?? []) {
      if (!seen.has(t)) {
        seen.add(t);
        queue.push(t);
      }
    }
  }
  return seen;
}

/**
 * For each node, the set of variable sources available to it on EVERY path from the trigger (the intersection over its
 * parents, each parent's own sources plus what the parent adds). Parents that the trigger does not reach are ignored
 * (they get their own "not connected" problem).
 */
export function availableSources(graph: Graph, order: readonly string[]): Map<string, Set<VarSource>> {
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const trigger = triggerOf(graph);
  const reach = trigger === null ? new Set<string>() : reachableFrom(graph, trigger.id);
  const parents = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || !reach.has(e.source)) continue;
    parents.set(e.target, [...(parents.get(e.target) ?? []), e.source]);
  }
  const out = new Map<string, Set<VarSource>>();
  const provided = (id: string): Set<VarSource> => {
    const spec = NODE_SPECS[(byId.get(id) as GraphNode).type];
    return new Set<VarSource>([...(out.get(id) ?? []), ...spec.provides]);
  };
  for (const id of order) {
    const ps = [...new Set(parents.get(id) ?? [])];
    if (ps.length === 0) {
      out.set(id, new Set<VarSource>(["always"]));
      continue;
    }
    const sets = ps.map(provided);
    const common = sets.reduce<Set<VarSource>>((acc, s) => new Set([...acc].filter((x) => s.has(x))), sets[0]);
    out.set(id, common);
  }
  return out;
}

export interface GraphProblem {
  node_id: string | null;
  message: string;
}
export interface ValidateOptions {
  /** false when the server has no human review (B4): a "When a hold is resolved" trigger is then a problem. Default true. */
  reviewTrigger?: boolean;
  /** When given, a webhook or chat step without a URL is a problem. The editor passes what it knows; the server passes the stored state. */
  secrets?: Record<string, { has_url: boolean }>;
}

/** The step that adds each source, for the "add X before this step" hint. */
const SOURCE_PROVIDER: Partial<Record<VarSource, NodeType>> = { vendor: "data.vendor", po: "data.po_balance", summary: "data.summarize" };

/** A variable's label without its trailing explanation ("Decision (APPROVE, HOLD, ...)" -> "Decision"), for sentences. */
export const shortLabel = (label: string): string => label.replace(/\s*\(.*\)$/, "");

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** "Unknown value", "not available here" and the variable checks of one template. */
function templateProblems(node: GraphNode, template: string, avail: Set<VarSource> | undefined): GraphProblem[] {
  const problems: GraphProblem[] = [];
  // anything that looks like a value but is not spelled like one would go out as literal text
  for (const stray of template.replace(TOKEN, "").match(/\{\{.*?\}\}/g) ?? []) problems.push({ node_id: node.id, message: `Unknown value ${cut(stray, 40)}.` });
  for (const name of templateVars(template)) {
    if (!isVarName(name)) {
      problems.push({ node_id: node.id, message: `Unknown value {{${name}}}.` });
      continue;
    }
    const source = VARIABLES[name].source;
    if (source === "always" || avail === undefined || avail.has(source)) continue;
    const provider = SOURCE_PROVIDER[source];
    problems.push({
      node_id: node.id,
      message: provider
        ? `{{${name}}} is not available here: add "${NODE_SPECS[provider].label}" before this step.`
        : `{{${name}}} is not available here: it needs an automation that starts from an invoice.`,
    });
  }
  return problems;
}

/** Problems with one condition row of an If step. */
function conditionProblems(node: GraphNode, c: Condition, avail: Set<VarSource> | undefined): GraphProblem[] {
  if (!isVarName(c.field)) return [{ node_id: node.id, message: `Unknown value "${cut(c.field, 40)}" in a condition.` }];
  const spec = VARIABLES[c.field];
  const problems: GraphProblem[] = [];
  if (spec.source !== "always" && avail !== undefined && !avail.has(spec.source)) {
    const provider = SOURCE_PROVIDER[spec.source];
    problems.push({
      node_id: node.id,
      message: provider
        ? `{{${c.field}}} is not available here: add "${NODE_SPECS[provider].label}" before this step.`
        : `{{${c.field}}} is not available here: it needs an automation that starts from an invoice.`,
    });
  }
  if (!OPS_BY_TYPE[spec.type].includes(c.op)) {
    problems.push({ node_id: node.id, message: `"${OP_WORDS[c.op]}" cannot be used with ${shortLabel(spec.label)}.` });
    return problems;
  }
  if (spec.type === "money" || spec.type === "count") {
    if (typeof c.value !== "number") problems.push({ node_id: node.id, message: `${shortLabel(spec.label)} needs a number.` });
  } else if (spec.type === "decision") {
    if (typeof c.value !== "string" || !(c.value in DECISION_WORDS)) problems.push({ node_id: node.id, message: `${shortLabel(spec.label)} needs one of: Approved, On hold, Rejected.` });
  } else if (spec.type === "review_action") {
    if (c.value !== "APPROVE" && c.value !== "REJECT") problems.push({ node_id: node.id, message: `${shortLabel(spec.label)} needs one of: Approved, Rejected.` });
  } else if (spec.type === "text") {
    if (typeof c.value !== "string") problems.push({ node_id: node.id, message: `${shortLabel(spec.label)} needs text.` });
  }
  return problems;
}

/** Structure first, then each step. `graph` is null only when the JSON does not match GraphSchema at all. */
export function validateGraph(input: unknown, opts: ValidateOptions = {}): { graph: Graph | null; problems: GraphProblem[] } {
  const parsed = GraphSchema.safeParse(input);
  if (!parsed.success) return { graph: null, problems: [{ node_id: null, message: "This automation could not be read." }] };
  const graph = parsed.data;
  const problems: GraphProblem[] = [];
  const add = (node_id: string | null, message: string) => problems.push({ node_id, message });

  const byId = new Map<string, GraphNode>();
  const reportedDuplicate = new Set<string>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) {
      if (!reportedDuplicate.has(n.id)) add(n.id, `Two steps share the id "${n.id}".`);
      reportedDuplicate.add(n.id);
    } else byId.set(n.id, n);
  }

  const triggers = graph.nodes.filter((n) => isTriggerType(n.type));
  if (triggers.length === 0) add(null, "Add a step that starts the automation.");
  for (const extra of triggers.slice(1)) add(extra.id, "An automation has exactly one starting step.");
  const trigger = triggers[0] ?? null;

  const seenEdges = new Set<string>();
  for (const e of graph.edges) {
    const from = byId.get(e.source);
    const to = byId.get(e.target);
    if (from === undefined || to === undefined) {
      add(null, "A connection points to a step that does not exist.");
      continue;
    }
    if (e.source === e.target) add(e.source, "A step cannot connect to itself.");
    const key = `${e.source}\u0000${e.sourceHandle}\u0000${e.target}`;
    if (seenEdges.has(key)) add(e.source, "These two steps are connected twice.");
    seenEdges.add(key);
    if (!NODE_SPECS[from.type].outputs.some((o) => o.id === e.sourceHandle)) add(e.source, "This connection leaves from an output the step does not have.");
    if (isTriggerType(to.type)) add(e.target, "Nothing can lead into the starting step.");
  }

  const withoutLoops: Graph = { nodes: graph.nodes, edges: graph.edges.filter((e) => e.source !== e.target) };
  const order = topoOrder(withoutLoops);
  if (order === null) add(null, "The steps go round in a circle; remove one connection.");

  if (trigger !== null) {
    const reach = reachableFrom(graph, trigger.id);
    for (const n of graph.nodes) if (!isTriggerType(n.type) && !reach.has(n.id)) add(n.id, "This step is not connected to the start.");
  }

  const avail = order === null ? null : availableSources(graph, order);
  const reviewTrigger = opts.reviewTrigger ?? true;
  for (const node of graph.nodes) {
    const schema = CONFIG_SCHEMAS[node.type] as z.ZodType;
    const cfg = schema.safeParse(node.config);
    if (!cfg.success) {
      const issue = cfg.error.issues[0];
      const where = issue.path.length > 0 ? `${issue.path.join(".")} ` : "";
      add(node.id, `This step's settings are not valid: ${cut(`${where}${issue.message}`, 120)}.`);
      continue;
    }
    const config = cfg.data as Record<string, unknown>;
    const here = avail?.get(node.id);
    if (node.type === "trigger.run_finished" && (config.decisions as unknown[]).length === 0 && config.include_errors === false) add(node.id, "Choose at least one outcome to start on.");
    if (node.type === "trigger.review_saved" && !reviewTrigger) add(node.id, "Resolving holds is not available on this server.");
    if (NODE_SPECS[node.type].needsRun && trigger?.type === "trigger.schedule") add(node.id, "This step needs an invoice, but this automation runs on a schedule.");
    switch (node.type) {
      case "logic.if":
        for (const c of config.conditions as Condition[]) for (const p of conditionProblems(node, c, here)) problems.push(p);
        break;
      case "action.note": {
        const text = config.text as string;
        for (const p of templateProblems(node, text, here)) problems.push(p);
        if (text.trim() === "") add(node.id, "Write the note's text.");
        break;
      }
      case "action.assign":
        if ((config.assignee as string).trim() === "") add(node.id, "Write who to assign to.");
        break;
      case "action.chat": {
        const text = config.text as string;
        for (const p of templateProblems(node, text, here)) problems.push(p);
        if (text.trim() === "") add(node.id, "Write the message.");
        break;
      }
      case "action.webhook": {
        const fields = config.fields as { key: string; value: string }[];
        if (fields.length === 0) add(node.id, "Add at least one field to send.");
        const keys = new Set<string>();
        const dup = new Set<string>();
        for (const f of fields) {
          if (keys.has(f.key)) dup.add(f.key);
          keys.add(f.key);
          for (const p of templateProblems(node, f.value, here)) problems.push(p);
        }
        for (const key of dup) add(node.id, `Two fields are both called "${key}".`);
        break;
      }
      default:
        break;
    }
    if (opts.secrets !== undefined && NODE_SPECS[node.type].hasUrl && opts.secrets[node.id]?.has_url !== true) add(node.id, "Add the webhook URL.");
  }
  return { graph, problems };
}

/* ---- the one-line summary of a step ---- */

const decisionWord = (d: string): string => (DECISION_WORDS[d] ?? d).toLowerCase();
const CANONICAL: readonly string[] = ["APPROVE", "HOLD", "REJECT"];
const inWords = (list: readonly string[]): string => {
  const words = CANONICAL.filter((d) => list.includes(d)).map(decisionWord);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
};

function moneyShort(n: number): string {
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : formatUsd(n);
}

function conditionInWords(c: Condition): string {
  const spec = isVarName(c.field) ? VARIABLES[c.field] : null;
  const label = spec ? shortLabel(spec.label) : c.field;
  const op = OP_WORDS[c.op];
  if (c.op === "is_true" || c.op === "is_false") return `${label} ${op}`;
  let value: string;
  if (spec?.type === "money" && typeof c.value === "number") value = moneyShort(c.value);
  else if ((spec?.type === "decision" || spec?.type === "review_action") && typeof c.value === "string") value = DECISION_WORDS[c.value] ?? c.value;
  else if (typeof c.value === "string") value = `"${cut(c.value, 40)}"`;
  else value = String(c.value);
  return `${label} ${op} ${value}`;
}

/** One sentence that describes a step's config, shown on its card ("Only invoices on hold", "Assign to AP lead"). */
export function summarizeStep(node: GraphNode): string {
  const parsed = (CONFIG_SCHEMAS[node.type] as z.ZodType).safeParse(node.config);
  if (!parsed.success) return "Settings are not valid";
  const c = parsed.data as Record<string, unknown>;
  switch (node.type) {
    case "trigger.run_finished": {
      const decisions = c.decisions as string[];
      const errors = c.include_errors === true;
      if (decisions.length === 0) return errors ? "Only invoices that end in a system error" : "No outcome chosen yet";
      const base = decisions.length === 3 ? "Every decided invoice" : `Only invoices that are ${inWords(decisions)}`;
      return errors ? `${base}, or end in a system error` : base;
    }
    case "trigger.review_saved": {
      const actions = c.actions as string[];
      return actions.length === 2 ? "When a hold is approved or rejected" : `When a hold is ${actions[0] === "APPROVE" ? "approved" : "rejected"}`;
    }
    case "trigger.schedule":
      return c.every === "day"
        ? `Every day at ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} UTC`
        : `Every hour at :${String(c.minute).padStart(2, "0")}`;
    case "logic.if": {
      const conditions = c.conditions as Condition[];
      const more = conditions.length - 1;
      return `If ${conditionInWords(conditions[0])}${more > 0 ? ` ${c.combine === "any" ? "or" : "and"} ${more} more` : ""}`;
    }
    case "logic.switch_decision":
      return "One way per decision";
    case "data.vendor":
    case "data.po_balance":
      return NODE_SPECS[node.type].label;
    case "data.summarize": {
      const hours = c.window_hours as number;
      return `Invoices ${inWords(c.decisions as string[])} in the last ${hours === 1 ? "hour" : `${hours} hours`}`;
    }
    case "action.note": {
      const text = (c.text as string).trim();
      return text === "" ? "No text yet" : cut(text, 60);
    }
    case "action.assign": {
      const who = (c.assignee as string).trim();
      return who === "" ? "No one chosen yet" : `Assign to ${who}`;
    }
    case "action.webhook": {
      const n = (c.fields as unknown[]).length;
      return `Sends ${n} ${n === 1 ? "field" : "fields"}`;
    }
    case "action.chat": {
      const text = (c.text as string).trim();
      return text === "" ? "No message yet" : cut(text, 60);
    }
  }
}

/** A short name for each type, the start of its generated ids. */
const SHORT_NAME: Readonly<Record<NodeType, string>> = {
  "trigger.run_finished": "start",
  "trigger.review_saved": "start",
  "trigger.schedule": "start",
  "logic.if": "if",
  "logic.switch_decision": "switch",
  "data.vendor": "vendor",
  "data.po_balance": "po",
  "data.summarize": "summarize",
  "action.note": "note",
  "action.assign": "assign",
  "action.webhook": "webhook",
  "action.chat": "chat",
};

/** A fresh node id: the type's short name + "-" + the lowest free number ("if-1", "note-2"). */
export function nextNodeId(graph: Graph, type: NodeType): string {
  const taken = new Set(graph.nodes.map((n) => n.id));
  for (let n = 1; ; n++) {
    const id = `${SHORT_NAME[type]}-${n}`;
    if (!taken.has(id)) return id;
  }
}
