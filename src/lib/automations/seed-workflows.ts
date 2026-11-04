/**
 * The three seed automations (plan 7.3) and how they get into a database: with a reset or a first boot (seed.ts calls
 * insertSeedWorkflows inside its transaction), and for a database that was seeded before the feature existed
 * (ensureWorkflowsSeeded, called by getDb). A person who deletes every automation is never re-seeded on a restart; only a
 * reset brings the seeds back. Imports db.ts for its TYPE only, so there is no runtime cycle. Server-only.
 */
import crypto from "node:crypto";
import type { DB } from "../db";
import { NODE_SPECS, type Graph, type GraphEdge, type GraphNode, type NodeType } from "../workflow-graph";

const node = (id: string, type: NodeType, name: string, x: number, y: number, config?: unknown): GraphNode => ({
  id,
  type,
  name,
  position: { x, y },
  config: (config ?? NODE_SPECS[type].defaultConfig()) as Record<string, unknown>,
});
const edge = (source: string, sourceHandle: string, target: string): GraphEdge => ({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target });

export interface SeedWorkflow {
  seed_key: string;
  name: string;
  enabled: boolean;
  graph: Graph;
}

function routeHolds(): Graph {
  return {
    nodes: [
      node("start", "trigger.run_finished", "When an invoice is decided", 0, 0, { decisions: ["HOLD"], include_errors: false }),
      node("if-security", "logic.if", "Is it flagged for security?", 280, 0, { combine: "all", conditions: [{ field: "run.security_flag", op: "is_true", value: null }] }),
      node("assign-security", "action.assign", "Assign to Finance security", 560, -80, { assignee: "Finance security" }),
      node("note-security", "action.note", "Note why", 840, -80, { text: "Security review needed before any payment: {{run.first_reason}}" }),
      node("if-large", "logic.if", "Is it over $5,000?", 560, 80, { combine: "all", conditions: [{ field: "run.total", op: "gt", value: 5000 }] }),
      node("assign-lead", "action.assign", "Assign to AP lead", 840, 40, { assignee: "AP lead" }),
      node("assign-clerk", "action.assign", "Assign to AP clerk", 840, 140, { assignee: "AP clerk" }),
    ],
    edges: [
      edge("start", "out", "if-security"),
      edge("if-security", "true", "assign-security"),
      edge("assign-security", "out", "note-security"),
      edge("if-security", "false", "if-large"),
      edge("if-large", "true", "assign-lead"),
      edge("if-large", "false", "assign-clerk"),
    ],
  };
}

function chatRejections(): Graph {
  return {
    nodes: [
      node("start", "trigger.run_finished", "When an invoice is decided", 0, 0, { decisions: ["REJECT"], include_errors: false }),
      node("chat", "action.chat", "Post to the team chat", 280, 0, { text: "Rejected: {{run.vendor_name}} {{run.invoice_number}} ({{run.total}}). {{run.first_reason}} {{run.url}}" }),
    ],
    edges: [edge("start", "out", "chat")],
  };
}

function dailyHolds(): Graph {
  return {
    nodes: [
      node("start", "trigger.schedule", "On a schedule", 0, 0, { every: "day", hour: 8, minute: 0 }),
      node("summarize", "data.summarize", "Summarize holds", 280, 0, { window_hours: 24, decisions: ["HOLD"], max_items: 10 }),
      node("if-any", "logic.if", "Are there any holds?", 560, 0, { combine: "all", conditions: [{ field: "summary.count", op: "gt", value: 0 }] }),
      node("chat", "action.chat", "Post the summary", 840, 0, {
        text: "{{summary.count}} invoices on hold in the last {{summary.window_hours}} hours ({{summary.total_value}}):\n{{summary.list}}",
      }),
    ],
    edges: [edge("start", "out", "summarize"), edge("summarize", "out", "if-any"), edge("if-any", "true", "chat")],
  };
}

/** Seed 1 is on; seeds 2 and 3 are off because they need a webhook URL. */
export const SEED_WORKFLOWS: readonly SeedWorkflow[] = [
  { seed_key: "route-holds", name: "Route holds to the right person", enabled: true, graph: routeHolds() },
  { seed_key: "chat-rejections", name: "Tell the team about rejections", enabled: false, graph: chatRejections() },
  { seed_key: "daily-holds", name: "Morning summary of holds", enabled: false, graph: dailyHolds() },
];

/** A fresh copy of one seed's graph (never shared with the constant above). */
export function seedGraph(seedKey: string): Graph | null {
  const seed = SEED_WORKFLOWS.find((s) => s.seed_key === seedKey);
  return seed === undefined ? null : (JSON.parse(JSON.stringify(seed.graph)) as Graph);
}

/** Inserts the three seeds. The trigger type is copied from the graph, as every save does. */
export function insertSeedWorkflows(db: DB, now: string): void {
  const insert = db.prepare(
    `INSERT INTO workflows (id, name, enabled, enabled_at, trigger_type, graph, secrets, version, seed_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', 1, ?, ?, ?)`,
  );
  for (const seed of SEED_WORKFLOWS) {
    const trigger = seed.graph.nodes[0].type.replace("trigger.", "");
    insert.run(crypto.randomUUID(), seed.name, seed.enabled ? 1 : 0, seed.enabled ? now : null, trigger, JSON.stringify(seed.graph), seed.seed_key, now, now);
  }
}

/**
 * First boot of a database that predates Automations: when `app_meta` has no "workflows_seeded" row, insert the seeds and
 * the row. A no-op afterwards, and after every automation was deleted on purpose.
 */
export function ensureWorkflowsSeeded(db: DB, now: Date = new Date()): boolean {
  if (db.prepare("SELECT 1 FROM app_meta WHERE key = 'workflows_seeded'").get() !== undefined) return false;
  const stamp = now.toISOString();
  db.transaction(() => {
    insertSeedWorkflows(db, stamp);
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('workflows_seeded', ?)").run(stamp);
  })();
  return true;
}
