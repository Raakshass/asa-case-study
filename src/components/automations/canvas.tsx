"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type EdgeChange,
  type OnBeforeDelete,
  type OnConnect,
  type OnConnectEnd,
  type OnEdgesChange,
  type OnNodeDrag,
  type OnNodesChange,
  type OnSelectionChangeFunc,
  type ProOptions,
} from "@xyflow/react";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import type { ExecutionDetail, ExecutionStep } from "@/lib/types";
import { NODE_SPECS, NODE_TYPES, isTriggerType, type Graph, type GraphProblem, type NodeType } from "@/lib/workflow-graph";
import { connect } from "./graph-edit";
import { EDGE_TYPES_RF, type LabelledEdgeType } from "./labelled-edge";
import { NODE_TYPES_RF, type StepNode } from "./step-card";

/** The dataTransfer type the palette sets (to the NodeType string) when a step is dragged out of it. */
export const PALETTE_DRAG_TYPE = "application/x-automation-step";

export interface CanvasProps {
  /** The working graph, or the shown execution's graph when `overlay` is set. */
  graph: Graph;
  selected: string | null;
  /** All problems of the working graph (node_id may be null). */
  problems: GraphProblem[];
  /** History overlay: the canvas is read-only, cards show their status, connections show taken or not taken. */
  overlay: ExecutionDetail | null;
  onSelect: (id: string | null) => void;
  /** Returns an error sentence when the connection is refused (shown through onStatus), null when accepted. */
  onConnect: (source: string, handle: string, target: string) => string | null;
  /** Called once when a drag (or a run of arrow-key moves) ends, with the moved steps. */
  onMoveEnd: (moves: { id: string; x: number; y: number }[]) => void;
  /** Delete on a selected step (never the starting step). */
  onDeleteSteps: (ids: string[]) => void;
  /** Delete on a selected connection. */
  onDeleteEdges: (ids: string[]) => void;
  /** A palette item was dropped; x and y are in flow coordinates. */
  onDropStep: (type: NodeType, x: number, y: number) => void;
  /** Text for the editor's status line (for example why a connection was refused). */
  onStatus: (text: string) => void;
  /** When set, centre that step at zoom 1. Runs again whenever `nonce` changes. */
  focusRequest: { id: string; nonce: number } | null;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const subscribeReducedMotion = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const readReducedMotion = (): boolean => window.matchMedia(REDUCED_MOTION).matches;

/** True when the person asked for less motion. The server snapshot is false; the canvas only renders on the client anyway. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
}

/** Module-level, so React Flow never sees a new object on a render. The attribution stays on (the library's licence asks for it). */
const PRO_OPTIONS: ProOptions = { hideAttribution: false };

const ARROW_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

const isNodeType = (value: string): value is NodeType => (NODE_TYPES as readonly string[]).includes(value);

/* ---- Graph to React Flow ------------------------------------------------------------------------------------------ */

function stepRows(overlay: ExecutionDetail | null): Map<string, ExecutionStep> {
  const rows = new Map<string, ExecutionStep>();
  if (overlay !== null) for (const step of overlay.steps) rows.set(step.node_id, step);
  return rows;
}

function toFlowNodes(graph: Graph, selected: string | null, problems: GraphProblem[], overlay: ExecutionDetail | null): StepNode[] {
  const rows = stepRows(overlay);
  return graph.nodes.map(
    (n): StepNode => ({
      id: n.id,
      type: "step",
      position: { x: n.position.x, y: n.position.y },
      selected: n.id === selected,
      deletable: NODE_SPECS[n.type].kind !== "trigger",
      ariaLabel: n.name,
      data: {
        node: n,
        // the problems are the working graph's: they say nothing about a graph that already ran, so the overlay shows none
        problems: overlay === null ? problems.filter((p) => p.node_id === n.id) : [],
        execStep: rows.get(n.id) ?? null,
        overlay: overlay !== null,
      },
    }),
  );
}

function toFlowEdges(graph: Graph, overlay: ExecutionDetail | null): LabelledEdgeType[] {
  const rows = stepRows(overlay);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges: LabelledEdgeType[] = [];
  for (const e of graph.edges) {
    const from = byId.get(e.source);
    const to = byId.get(e.target);
    // A connection to a step that is missing, from an output the step does not have, or into a starting step has no handle to
    // draw to; the validator reports it, and drawing it would only make React Flow log an error.
    if (from === undefined || to === undefined || NODE_SPECS[to.type].kind === "trigger") continue;
    const outputs = NODE_SPECS[from.type].outputs;
    const output = outputs.find((o) => o.id === e.sourceHandle);
    if (output === undefined) continue;
    const label = outputs.length > 1 ? output.label : "";
    let taken: boolean | null = null;
    if (overlay !== null) {
      const a = rows.get(e.source);
      const b = rows.get(e.target);
      taken = a !== undefined && a.status === "success" && a.chosen_output === e.sourceHandle && b !== undefined && b.status !== "skipped";
    }
    edges.push({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      type: "labelled",
      data: { label, taken },
      ariaLabel: `Connection from ${from.name}${label !== "" ? ` (${label})` : ""} to ${to.name}`,
    });
  }
  return edges;
}

const sameProblems = (a: GraphProblem[], b: GraphProblem[]): boolean => a.length === b.length && a.every((p, i) => p.message === b[i].message);

/**
 * Brings the local nodes up to date with the graph. A node that did not change keeps its object (and so what React Flow measured
 * of it); one that did keeps its measured size. When nothing changed, the same array comes back, so no render follows.
 */
function mergeNodes(next: StepNode[], prev: StepNode[]): StepNode[] {
  const before = new Map(prev.map((n) => [n.id, n]));
  let changed = next.length !== prev.length;
  const merged = next.map((n, i) => {
    const old = before.get(n.id);
    if (old === undefined) {
      changed = true;
      return n;
    }
    const same =
      old.position.x === n.position.x &&
      old.position.y === n.position.y &&
      Boolean(old.selected) === Boolean(n.selected) &&
      old.deletable === n.deletable &&
      old.ariaLabel === n.ariaLabel &&
      old.data.node === n.data.node &&
      old.data.overlay === n.data.overlay &&
      old.data.execStep === n.data.execStep &&
      sameProblems(old.data.problems, n.data.problems);
    if (same) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return { ...old, ...n };
  });
  return changed ? merged : prev;
}

function mergeEdges(next: LabelledEdgeType[], prev: LabelledEdgeType[]): LabelledEdgeType[] {
  const before = new Map(prev.map((e) => [e.id, e]));
  let changed = next.length !== prev.length;
  const merged = next.map((e, i) => {
    const old = before.get(e.id);
    if (old === undefined) {
      changed = true;
      return e;
    }
    const same =
      old.source === e.source &&
      old.sourceHandle === e.sourceHandle &&
      old.target === e.target &&
      old.ariaLabel === e.ariaLabel &&
      old.data?.label === e.data?.label &&
      old.data?.taken === e.data?.taken;
    if (same) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return { ...e, selected: old.selected };
  });
  return changed ? merged : prev;
}

/* ---- The zoom buttons ---------------------------------------------------------------------------------------------- */

/** Our own zoom buttons: React Flow's Controls are smaller than 24 px. Real buttons, 32 px (see automations.css). */
function ZoomButtons({ reduced }: { reduced: boolean }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const duration = reduced ? 0 : 200;
  return (
    <>
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => void zoomOut({ duration })}>
        <ZoomOut aria-hidden="true" size={16} />
      </button>
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => void zoomIn({ duration })}>
        <ZoomIn aria-hidden="true" size={16} />
      </button>
      <button type="button" aria-label="Fit to screen" title="Fit to screen" onClick={() => void fitView({ padding: 0.2, duration })}>
        <Maximize aria-hidden="true" size={16} />
      </button>
    </>
  );
}

/* ---- The canvas ---------------------------------------------------------------------------------------------------- */

function CanvasInner({ graph, selected, problems, overlay, onSelect, onConnect, onMoveEnd, onDeleteSteps, onDeleteEdges, onDropStep, onStatus, focusRequest }: CanvasProps) {
  const reduced = usePrefersReducedMotion();
  const { screenToFlowPosition, setCenter, fitView } = useReactFlow<StepNode, LabelledEdgeType>();
  const readOnly = overlay !== null;

  const derivedNodes = useMemo(() => toFlowNodes(graph, selected, problems, overlay), [graph, selected, problems, overlay]);
  const derivedEdges = useMemo(() => toFlowEdges(graph, overlay), [graph, overlay]);

  // A local copy of the nodes and connections, so dragging and selecting are smooth. The graph (through the props) stays the
  // truth: whenever it changes, the copy is brought up to date, except while a drag is in progress.
  const [nodes, setNodes] = useState<StepNode[]>(derivedNodes);
  const [edges, setEdges] = useState<LabelledEdgeType[]>(derivedEdges);
  const [syncTick, setSyncTick] = useState(0);
  useEffect(() => {
    setNodes((prev) => (prev.some((n) => n.dragging === true) ? prev : mergeNodes(derivedNodes, prev)));
    setEdges((prev) => mergeEdges(derivedEdges, prev));
  }, [derivedNodes, derivedEdges, syncTick]);

  /* positions, selection and sizes; a removal never changes the local copy: it goes to the editor, and comes back as a new graph */
  const onNodesChange: OnNodesChange<StepNode> = useCallback((changes) => {
    const kept = changes.filter((c) => c.type !== "remove");
    if (kept.length > 0) setNodes((prev) => applyNodeChanges(kept, prev));
  }, []);
  const onEdgesChange: OnEdgesChange<LabelledEdgeType> = useCallback((changes: EdgeChange<LabelledEdgeType>[]) => {
    const kept = changes.filter((c) => c.type !== "remove");
    if (kept.length > 0) setEdges((prev) => applyEdgeChanges(kept, prev));
  }, []);

  /** Moves that differ from the graph, rounded the way the graph keeps them. */
  const movesFrom = useCallback(
    (moved: { id: string; position: { x: number; y: number } }[]): { id: string; x: number; y: number }[] => {
      const out: { id: string; x: number; y: number }[] = [];
      for (const m of moved) {
        const known = graph.nodes.find((n) => n.id === m.id);
        const x = Math.round(m.position.x);
        const y = Math.round(m.position.y);
        if (known !== undefined && (known.position.x !== x || known.position.y !== y)) out.push({ id: m.id, x, y });
      }
      return out;
    },
    [graph],
  );

  const onNodeDragStop: OnNodeDrag<StepNode> = useCallback(
    (_event, node, dragged) => {
      const moves = movesFrom(dragged.length > 0 ? dragged : [node]);
      if (moves.length > 0) onMoveEnd(moves);
      setSyncTick((t) => t + 1);
    },
    [movesFrom, onMoveEnd],
  );

  // Arrow keys on a selected, focused step move it (React Flow's own keyboard path). That fires no drag events, so the move is
  // committed when the key is released: one change for a whole run of presses.
  const onKeyUp = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (readOnly || !ARROW_KEYS.includes(event.key)) return;
      const moves = movesFrom(nodes.filter((n) => n.selected === true));
      if (moves.length > 0) onMoveEnd(moves);
      setSyncTick((t) => t + 1);
    },
    [movesFrom, nodes, onMoveEnd, readOnly],
  );

  const onSelectionChange: OnSelectionChangeFunc<StepNode, LabelledEdgeType> = useCallback(({ nodes: picked }) => onSelect(picked[0]?.id ?? null), [onSelect]);

  /* connections: React Flow only calls onConnect for a valid one, so a refusal is reported when the connection ends */
  const isValidConnection = useCallback(
    (c: { source: string; target: string; sourceHandle?: string | null }): boolean => connect(graph, c.source, c.sourceHandle ?? "out", c.target).ok,
    [graph],
  );
  const handleConnect: OnConnect = useCallback(
    (c) => {
      const refusal = onConnect(c.source, c.sourceHandle ?? "out", c.target);
      if (refusal !== null) onStatus(refusal);
    },
    [onConnect, onStatus],
  );
  const handleConnectEnd: OnConnectEnd = useCallback(
    (_event, state) => {
      if (state.isValid !== false || state.fromNode === null || state.fromHandle === null || state.toNode === null) return;
      const result = connect(graph, state.fromNode.id, state.fromHandle.id ?? "out", state.toNode.id);
      if (!result.ok) onStatus(result.error);
    },
    [graph, onStatus],
  );

  /* Delete: the editor removes steps and connections (and keeps the undo history); the local copy then follows the new graph */
  const onBeforeDelete: OnBeforeDelete<StepNode, LabelledEdgeType> = useCallback(
    async ({ nodes: doomed, edges: doomedEdges }) => {
      if (readOnly) return false;
      const stepIds = doomed.filter((n) => !isTriggerType(n.data.node.type)).map((n) => n.id);
      const gone = new Set(stepIds);
      // a connection that leaves with its step goes with it; only the ones deleted on their own are reported
      const edgeIds = doomedEdges.filter((e) => !gone.has(e.source) && !gone.has(e.target)).map((e) => e.id);
      if (stepIds.length > 0) onDeleteSteps(stepIds);
      if (edgeIds.length > 0) onDeleteEdges(edgeIds);
      return false;
    },
    [onDeleteEdges, onDeleteSteps, readOnly],
  );

  /* a step dragged out of the palette */
  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (readOnly || !Array.from(event.dataTransfer.types).includes(PALETTE_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [readOnly],
  );
  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (readOnly) return;
      const raw = event.dataTransfer.getData(PALETTE_DRAG_TYPE);
      if (!isNodeType(raw) || isTriggerType(raw)) return;
      event.preventDefault();
      const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onDropStep(raw, Math.round(at.x), Math.round(at.y));
    },
    [onDropStep, readOnly, screenToFlowPosition],
  );

  /* centre a step when asked (a request that was already there when the canvas appeared is not a new one) */
  const lastNonce = useRef<number | null>(focusRequest?.nonce ?? null);
  useEffect(() => {
    if (focusRequest === null || lastNonce.current === focusRequest.nonce) return;
    lastNonce.current = focusRequest.nonce;
    const target = graph.nodes.find((n) => n.id === focusRequest.id);
    if (target !== undefined) void setCenter(target.position.x + 120, target.position.y + 30, { zoom: 1, duration: reduced ? 0 : 200 });
  }, [focusRequest, graph, reduced, setCenter]);

  // Fit the steps into view once, as soon as React Flow has measured them (more dependable than the fitView prop, which can run
  // before the steps have a size when the page is busy).
  const measured = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (!measured || fitted.current) return;
    fitted.current = true;
    void fitView({ padding: 0.2, duration: reduced ? 0 : 200 });
  }, [measured, fitView, reduced]);

  return (
    <div className="automation-canvas h-full w-full" data-overlay={readOnly ? "true" : undefined}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES_RF}
        edgeTypes={EDGE_TYPES_RF}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={onSelectionChange}
        onBeforeDelete={onBeforeDelete}
        deleteKeyCode="Delete"
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        edgesFocusable={false}
        edgesReconnectable={false}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        minZoom={0.4}
        maxZoom={1.5}
        proOptions={PRO_OPTIONS}
        aria-label="Automation steps canvas"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onKeyUp={onKeyUp}
      >
        <Panel position="bottom-left" className="automation-zoom" role="group" aria-label="Zoom">
          <ZoomButtons reduced={reduced} />
        </Panel>
      </ReactFlow>
    </div>
  );
}

/**
 * The canvas of the editor (plan 8.7): a ledger sheet with the steps drawn as index cards. It wraps its own React Flow provider.
 * The editor keeps the graph; this component draws it, and reports what the person did (select, connect, move, delete, drop).
 */
export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
