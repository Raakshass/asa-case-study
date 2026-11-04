/**
 * Pure helpers that change a Graph (plan A10), used by the editor, the canvas and the Steps view: every function takes a
 * graph and returns a new one, and never touches the one it was given. Nothing here knows about React, the DOM or the
 * server. They keep the rules the server enforces (one trigger, no connection into it, no cycle, no duplicate, only the
 * outputs a step has), so an edit that the editor allows is one the server will read.
 */
import {
  NODE_SPECS,
  TRIGGER_TYPES,
  isTriggerType,
  nextNodeId,
  topoOrder,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
} from "@/lib/workflow-graph";

/** The distance between a step and the one after it, and between two steps after the same output. */
export const COLUMN_GAP = 280;
export const ROW_GAP = 140;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A connection id that is unique in the graph and made only of characters an id may hold. */
function edgeId(graph: Graph, source: string, handle: string, target: string): string {
  const base = `${source}-${handle.toLowerCase().replace(/[^a-z0-9_-]/g, "")}-${target}`.slice(0, 78);
  const taken = new Set(graph.edges.map((e) => e.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

export const nodeById = (graph: Graph, id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);

/** The steps a step's output leads to, in the order they were connected. */
export function childrenOn(graph: Graph, parentId: string, output: string): GraphNode[] {
  return graph.edges
    .filter((e) => e.source === parentId && e.sourceHandle === output)
    .map((e) => nodeById(graph, e.target))
    .filter((n): n is GraphNode => n !== undefined);
}

/** The outputs of a step that lead nowhere yet. */
export function freeOutputs(graph: Graph, id: string): string[] {
  const node = nodeById(graph, id);
  if (node === undefined) return [];
  return NODE_SPECS[node.type].outputs.map((o) => o.id).filter((out) => !graph.edges.some((e) => e.source === id && e.sourceHandle === out));
}

export type EditResult = { ok: true; graph: Graph } | { ok: false; error: string };

/**
 * Adds a step connected from `parentId`'s `output` (or, with no parent, unconnected). It is placed 280 px to the right of its
 * parent, and 140 px below the parent's previous child on the same output. A starting step is never added this way
 * (use replaceTrigger). Returns the new graph and the new step's id.
 */
export function addStepAfter(graph: Graph, parentId: string | null, output: string, type: NodeType): { graph: Graph; id: string } {
  if (isTriggerType(type)) throw new Error("A starting step is changed with replaceTrigger.");
  const id = nextNodeId(graph, type);
  const parent = parentId === null ? undefined : nodeById(graph, parentId);
  let x = 0;
  let y = 0;
  if (parent !== undefined) {
    x = parent.position.x + COLUMN_GAP;
    const siblings = childrenOn(graph, parent.id, output);
    y = siblings.length === 0 ? parent.position.y : Math.max(...siblings.map((s) => s.position.y)) + ROW_GAP;
  }
  const node: GraphNode = { id, type, name: NODE_SPECS[type].label, position: { x, y }, config: clone(NODE_SPECS[type].defaultConfig()) as Record<string, unknown> };
  const next: Graph = { nodes: [...graph.nodes, node], edges: [...graph.edges] };
  if (parent !== undefined && NODE_SPECS[parent.type].outputs.some((o) => o.id === output)) {
    next.edges.push({ id: edgeId(next, parent.id, output, id), source: parent.id, sourceHandle: output, target: id });
  }
  return { graph: next, id };
}

/** Adds a step at a position, unconnected (a drag from the palette). */
export function addStepAt(graph: Graph, type: NodeType, x: number, y: number): { graph: Graph; id: string } {
  const { graph: next, id } = addStepAfter(graph, null, "out", type);
  return { graph: setPosition(next, id, x, y), id };
}

/**
 * Connects `source`'s output `handle` to `target`. Refused (with a sentence for the editor's status line) when a step is
 * missing, it would connect a step to itself, lead into the starting step, leave from an output the step does not have, repeat
 * a connection, or make the steps go round in a circle.
 */
export function connect(graph: Graph, source: string, handle: string, target: string): EditResult {
  const from = nodeById(graph, source);
  const to = nodeById(graph, target);
  if (from === undefined || to === undefined) return { ok: false, error: "That step does not exist." };
  if (source === target) return { ok: false, error: "A step cannot connect to itself." };
  if (isTriggerType(to.type)) return { ok: false, error: "Nothing can lead into the starting step." };
  if (!NODE_SPECS[from.type].outputs.some((o) => o.id === handle)) return { ok: false, error: "That step has no such output." };
  if (graph.edges.some((e) => e.source === source && e.sourceHandle === handle && e.target === target)) return { ok: false, error: "These two steps are already connected that way." };
  const next: Graph = { nodes: graph.nodes, edges: [...graph.edges, { id: edgeId(graph, source, handle, target), source, sourceHandle: handle, target }] };
  if (topoOrder(next) === null) return { ok: false, error: "That connection would make the steps go round in a circle." };
  return { ok: true, graph: next };
}

/** Removes one connection. */
export function removeEdge(graph: Graph, id: string): Graph {
  return { nodes: graph.nodes, edges: graph.edges.filter((e) => e.id !== id) };
}

/** Removes a step and every connection to or from it. The starting step cannot be removed. */
export function removeStep(graph: Graph, id: string): Graph {
  const node = nodeById(graph, id);
  if (node === undefined || isTriggerType(node.type)) return graph;
  return { nodes: graph.nodes.filter((n) => n.id !== id), edges: graph.edges.filter((e) => e.source !== id && e.target !== id) };
}

/** A copy of a step with the same settings and a new id, 40 px right and down, connected to nothing. The starting step cannot be copied. */
export function duplicateStep(graph: Graph, id: string): { graph: Graph; id: string } | null {
  const node = nodeById(graph, id);
  if (node === undefined || isTriggerType(node.type)) return null;
  const copyId = nextNodeId(graph, node.type);
  const copy: GraphNode = { ...clone(node), id: copyId, name: node.name.length > 55 ? node.name : `${node.name} copy`, position: { x: node.position.x + 40, y: node.position.y + 40 } };
  return { graph: { nodes: [...graph.nodes, copy], edges: graph.edges }, id: copyId };
}

const mapNode = (graph: Graph, id: string, change: (n: GraphNode) => GraphNode): Graph => ({ nodes: graph.nodes.map((n) => (n.id === id ? change(n) : n)), edges: graph.edges });

/** A new name for a step (trimmed; an empty name keeps the old one). */
export function renameStep(graph: Graph, id: string, name: string): Graph {
  const trimmed = name.trim().slice(0, 60);
  return trimmed === "" ? graph : mapNode(graph, id, (n) => ({ ...n, name: trimmed }));
}

/** New settings for a step. */
export function setConfig(graph: Graph, id: string, config: Record<string, unknown>): Graph {
  return mapNode(graph, id, (n) => ({ ...n, config }));
}

export function setPosition(graph: Graph, id: string, x: number, y: number): Graph {
  const clamp = (v: number): number => Math.min(100_000, Math.max(-100_000, Math.round(v)));
  return mapNode(graph, id, (n) => ({ ...n, position: { x: clamp(x), y: clamp(y) } }));
}

/**
 * Changes what starts the automation. The starting step keeps its id, its place and its connections (every starting step
 * has the one output, "out"); its settings go back to the new type's defaults. With no starting step, one is added.
 */
export function replaceTrigger(graph: Graph, type: (typeof TRIGGER_TYPES)[number]): Graph {
  const current = graph.nodes.find((n) => isTriggerType(n.type));
  const spec = NODE_SPECS[type];
  if (current === undefined) {
    const id = nextNodeId(graph, type);
    return { nodes: [{ id, type, name: spec.label, position: { x: 0, y: 0 }, config: clone(spec.defaultConfig()) as Record<string, unknown> }, ...graph.nodes], edges: graph.edges };
  }
  return mapNode(graph, current.id, (n) => ({ ...n, type, name: spec.label, config: clone(spec.defaultConfig()) as Record<string, unknown> }));
}

/** The connections into a step, with the step each comes from. */
export function incoming(graph: Graph, id: string): { edge: GraphEdge; from: GraphNode }[] {
  const out: { edge: GraphEdge; from: GraphNode }[] = [];
  for (const edge of graph.edges) {
    const from = nodeById(graph, edge.source);
    if (edge.target === id && from !== undefined) out.push({ edge, from });
  }
  return out;
}

/** The words for an output of a step ("Yes", "On hold"), or "" for a step with a single output. */
export function outputLabel(node: GraphNode, handle: string): string {
  const outputs = NODE_SPECS[node.type].outputs;
  return outputs.length > 1 ? (outputs.find((o) => o.id === handle)?.label ?? handle) : "";
}

/** One line of the Steps view. */
export type OutlineRow =
  | { kind: "label"; text: string; depth: number }
  | { kind: "step"; node: GraphNode; depth: number; number: number; alsoFrom: string[] }
  | { kind: "loose"; node: GraphNode; number: number };

/**
 * The Steps view's rows: a tree drawn from the starting step. Each step appears once, under the first of its parents in
 * the order the steps run, and under that parent's output label ("Yes:", "On hold:") when the parent branches. A step
 * with two parents says "Also reached from" the others. Steps the start does not reach come last, as "loose".
 */
export function outlineRows(graph: Graph): OutlineRow[] {
  const trigger = graph.nodes.find((n) => isTriggerType(n.type));
  const order = topoOrder(graph) ?? graph.nodes.map((n) => n.id);
  const rank = new Map(order.map((id, i) => [id, i]));
  const parentOf = new Map<string, { edge: GraphEdge; parent: string }>();
  const alsoFrom = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const ins = graph.edges
      .filter((e) => e.target === node.id && nodeById(graph, e.source) !== undefined && e.source !== node.id)
      .sort((a, b) => (rank.get(a.source) ?? 0) - (rank.get(b.source) ?? 0));
    if (ins.length === 0) continue;
    parentOf.set(node.id, { edge: ins[0], parent: ins[0].source });
    const others = [...new Set(ins.slice(1).map((e) => e.source))].filter((s) => s !== ins[0].source).map((s) => nodeById(graph, s)?.name ?? s);
    if (others.length > 0) alsoFrom.set(node.id, others);
  }
  const rows: OutlineRow[] = [];
  const placed = new Set<string>();
  let counter = 0;
  const visit = (node: GraphNode, depth: number): void => {
    if (placed.has(node.id)) return;
    placed.add(node.id);
    rows.push({ kind: "step", node, depth, number: ++counter, alsoFrom: alsoFrom.get(node.id) ?? [] });
    const spec = NODE_SPECS[node.type];
    for (const output of spec.outputs) {
      const kids = graph.nodes
        .filter((n) => parentOf.get(n.id)?.parent === node.id && parentOf.get(n.id)?.edge.sourceHandle === output.id)
        .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      if (kids.length === 0) continue;
      const label = spec.outputs.length > 1 ? output.label : "";
      if (label !== "") rows.push({ kind: "label", text: `${label}:`, depth: depth + 1 });
      for (const kid of kids) visit(kid, label !== "" ? depth + 2 : depth + 1);
    }
  };
  if (trigger !== undefined) visit(trigger, 0);
  for (const node of [...graph.nodes].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))) {
    if (!placed.has(node.id)) {
      placed.add(node.id);
      rows.push({ kind: "loose", node, number: ++counter });
    }
  }
  return rows;
}
