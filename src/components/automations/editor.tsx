"use client";

import "@xyflow/react/dist/base.css";
import "@/app/automations/automations.css";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, FlaskConical, Pencil, Redo2, Save, Undo2 } from "lucide-react";
import { cn } from "cn";
import { ApiFailure, deleteAutomation, getAutomation, saveAutomation, setAutomationEnabled, testAutomation, unwrap, type SaveAutomationBody } from "@/components/shared/api";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { usePoll } from "@/components/shared/use-poll";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AutomationDetail, ExecutionDetail } from "@/lib/types";
import { NODE_SPECS, TRIGGER_TYPES, availableSources, topoOrder, validateGraph, type Graph, type GraphProblem, type NodeType } from "@/lib/workflow-graph";
import { addStepAfter, addStepAt, connect, duplicateStep, freeOutputs, nodeById, outlineRows, removeEdge, removeStep, renameStep, replaceTrigger, setConfig, setPosition } from "./graph-edit";
import { HistoryPanel } from "./history-panel";
import { Inspector } from "./inspector";
import { Palette } from "./palette";
import { StepsOutline } from "./steps-outline";
import { TestDialog } from "./test-dialog";
import { useTokenAction } from "./use-token-action";
import type { SecretEdit } from "./forms/secret-url-field";

/** The canvas is loaded only when it is drawn (wide screens): the Steps view never pays for it. */
const Canvas = dynamic(() => import("./canvas").then((m) => m.Canvas), { ssr: false, loading: () => <p className="p-4 text-sm text-muted-foreground">Loading the canvas...</p> });

/* ------------------------------------------------------------------------------------------------ state */

const HISTORY_LIMIT = 50;
const BURST_MS = 400;

type Status = { kind: "idle" | "saving" | "saved" | "error"; text: string };
interface EditorState {
  saved: AutomationDetail | null;
  graph: Graph;
  name: string;
  secretEdits: Record<string, SecretEdit>;
  selected: string | null;
  view: "canvas" | "steps" | null;
  panel: "settings" | "history";
  past: Graph[];
  future: Graph[];
  overlay: ExecutionDetail | null;
  status: Status;
}

type Action =
  | { type: "load"; detail: AutomationDetail; status?: Status }
  | { type: "commit"; graph: Graph; selected?: string | null }
  | { type: "live"; graph: Graph }
  | { type: "checkpoint"; before: Graph }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "name"; name: string }
  | { type: "select"; id: string | null; panel?: "settings" | "history" }
  | { type: "view"; view: "canvas" | "steps" }
  | { type: "panel"; panel: "settings" | "history" }
  | { type: "secret"; nodeId: string; edit: SecretEdit | undefined }
  | { type: "status"; status: Status }
  | { type: "overlay"; overlay: ExecutionDetail | null };

const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };
const INITIAL: EditorState = { saved: null, graph: EMPTY_GRAPH, name: "", secretEdits: {}, selected: null, view: null, panel: "settings", past: [], future: [], overlay: null, status: { kind: "idle", text: "" } };
const same = (a: Graph, b: Graph): boolean => JSON.stringify(a) === JSON.stringify(b);
const pushPast = (past: Graph[], g: Graph): Graph[] => [...past, g].slice(-HISTORY_LIMIT);

function reduce(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case "load":
      return {
        ...state,
        saved: action.detail,
        graph: action.detail.graph,
        name: action.detail.name,
        secretEdits: {},
        selected: state.selected !== null && nodeById(action.detail.graph, state.selected) !== undefined ? state.selected : null,
        past: [],
        future: [],
        status: action.status ?? state.status,
      };
    case "commit":
      return same(state.graph, action.graph) ? state : { ...state, graph: action.graph, past: pushPast(state.past, state.graph), future: [], selected: action.selected === undefined ? state.selected : action.selected };
    case "live":
      return { ...state, graph: action.graph };
    case "checkpoint":
      return same(state.graph, action.before) ? state : { ...state, past: pushPast(state.past, action.before), future: [] };
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return state;
      return { ...state, graph: previous, past: state.past.slice(0, -1), future: [state.graph, ...state.future].slice(0, HISTORY_LIMIT), selected: state.selected !== null && nodeById(previous, state.selected) === undefined ? null : state.selected };
    }
    case "redo": {
      const next = state.future[0];
      if (next === undefined) return state;
      return { ...state, graph: next, future: state.future.slice(1), past: pushPast(state.past, state.graph), selected: state.selected !== null && nodeById(next, state.selected) === undefined ? null : state.selected };
    }
    case "name":
      return { ...state, name: action.name };
    case "select":
      // The canvas reports its selection again whenever it redraws: the same selection changes nothing. While an execution is
      // shown, choosing a step keeps the History panel open (closing it would drop the overlay).
      if (action.id === state.selected && action.panel === undefined) return state;
      return { ...state, selected: action.id, panel: action.panel ?? (action.id === null || state.overlay !== null ? state.panel : "settings") };
    case "view":
      return { ...state, view: action.view };
    case "panel":
      return { ...state, panel: action.panel };
    case "secret": {
      const next = { ...state.secretEdits };
      if (action.edit === undefined) delete next[action.nodeId];
      else next[action.nodeId] = action.edit;
      return { ...state, secretEdits: next };
    }
    case "status":
      return { ...state, status: action.status };
    case "overlay":
      return state.overlay === action.overlay ? state : { ...state, overlay: action.overlay };
  }
}

/* ------------------------------------------------------------------------------------------------ small pieces */

const WIDE_QUERY = "(min-width: 1024px)";
function subscribeWide(callback: () => void): () => void {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}
/** Wide screens only. The server snapshot is false, so the server and the first client render both show the Steps view. */
const useWide = (): boolean => useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => false);

function timeOf(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

const isTextTarget = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(el.type)));

/** The secret state the validation sees: the saved state with what has been typed since. */
function mergedHasUrl(detail: AutomationDetail, edits: Record<string, SecretEdit>, graph: Graph): Record<string, { has_url: boolean }> {
  const out: Record<string, { has_url: boolean }> = {};
  for (const n of graph.nodes) {
    if (!NODE_SPECS[n.type].hasUrl) continue;
    const e = edits[n.id]?.url;
    out[n.id] = { has_url: e === undefined ? (detail.secrets[n.id]?.has_url ?? false) : e !== null && e !== "" };
  }
  return out;
}

function Switch({ enabled, disabled, onToggle, name }: { enabled: boolean; disabled: boolean; onToggle: () => void; name: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`Turn ${name} ${enabled ? "off" : "on"}`}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "inline-flex h-9 min-w-[4.25rem] items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
        enabled ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-muted",
      )}
    >
      <span aria-hidden="true">{enabled ? "■" : "□"}</span>
      {enabled ? "On" : "Off"}
    </button>
  );
}

/* ------------------------------------------------------------------------------------------------ the editor */

/**
 * The automation editor (plan A10). One state (a reducer, no state library) holds the saved copy, the working graph, the
 * name, the secrets typed since the last save, the selection, undo and redo, and the history overlay. From 1024 px the
 * canvas and the Steps view are two views of the same graph; below it only the Steps view is shown, and it can do
 * everything but drag positions. Save, turning on, testing and deleting need the operator token (asked for inline). Every
 * text from an automation is plain text.
 */
export function AutomationEditor({ id }: { id: string }) {
  const router = useRouter();
  const wide = useWide();
  const { data: loaded, error: loadError, loading, refresh } = usePoll((signal) => unwrap(getAutomation(id, signal)), { intervalMs: 0, resetKey: id });
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const { run, prompt, busy } = useTokenAction();
  // the test dialog is modal, so it has its own token form inside it (the page behind a modal is inert)
  const testToken = useTokenAction();
  const [renaming, setRenaming] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [openExecution, setOpenExecution] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [problemsNotice, setProblemsNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const burst = useRef<{ before: Graph; timer: ReturnType<typeof setTimeout> } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const nonce = useRef(0);
  const setOverlay = useCallback((detail: ExecutionDetail | null) => dispatch({ type: "overlay", overlay: detail }), []);

  // the first load (and a reload after the id changed) seeds the editor state
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (loaded !== null && seeded.current !== loaded.id + loaded.version) {
      seeded.current = loaded.id + loaded.version;
      dispatch({ type: "load", detail: loaded });
    }
  }, [loaded]);

  const saved = state.saved;
  const graph = state.graph;
  const order = useMemo(() => topoOrder(graph), [graph]);
  const sources = useMemo(() => (order === null ? null : availableSources(graph, order)), [graph, order]);
  const problems: GraphProblem[] = useMemo(
    () => (saved === null ? [] : validateGraph(graph, { reviewTrigger: saved.review_trigger_available, secrets: mergedHasUrl(saved, state.secretEdits, graph) }).problems),
    [graph, saved, state.secretEdits],
  );
  const dirty = saved !== null && (state.name !== saved.name || Object.keys(state.secretEdits).length > 0 || !same(graph, saved.graph));
  const view = wide ? (state.view ?? "canvas") : "steps";
  const readOnly = state.overlay !== null;

  /* ---- editing ---- */

  const flushBurst = useCallback(() => {
    if (burst.current === null) return;
    clearTimeout(burst.current.timer);
    dispatch({ type: "checkpoint", before: burst.current.before });
    burst.current = null;
  }, []);
  useEffect(() => () => {
    if (burst.current !== null) clearTimeout(burst.current.timer);
  }, []);

  /** A change that arrives key by key (a name, a setting): shown at once, one undo step per burst of 400 ms. */
  const liveChange = useCallback((next: Graph) => {
    if (burst.current === null) burst.current = { before: stateRef.current.graph, timer: setTimeout(() => undefined, 0) };
    clearTimeout(burst.current.timer);
    const before = burst.current.before;
    burst.current.timer = setTimeout(() => {
      dispatch({ type: "checkpoint", before });
      burst.current = null;
    }, BURST_MS);
    dispatch({ type: "live", graph: next });
  }, []);

  const commit = useCallback(
    (next: Graph, selected?: string | null) => {
      flushBurst();
      dispatch({ type: "commit", graph: next, selected });
    },
    [flushBurst],
  );

  const focusEdit = useCallback((stepId: string | null) => {
    requestAnimationFrame(() => {
      if (stepId === null) return;
      document.querySelector<HTMLElement>(`[data-edit="${stepId}"]`)?.focus();
    });
  }, []);

  const undo = useCallback(() => {
    flushBurst();
    dispatch({ type: "undo" });
  }, [flushBurst]);
  const redo = useCallback(() => {
    flushBurst();
    dispatch({ type: "redo" });
  }, [flushBurst]);

  const addFromPalette = useCallback(
    (type: NodeType) => {
      const current = stateRef.current.graph;
      const selected = stateRef.current.selected;
      const lastId = (topoOrder(current) ?? current.nodes.map((n) => n.id)).at(-1) ?? null;
      const parentId = selected !== null && nodeById(current, selected) !== undefined ? selected : lastId;
      const parent = parentId === null ? null : nodeById(current, parentId);
      const output = parent === null || parent === undefined ? "out" : (freeOutputs(current, parent.id)[0] ?? NODE_SPECS[parent.type].outputs[0].id);
      const added = addStepAfter(current, parentId, output, type);
      commit(added.graph, added.id);
      dispatch({ type: "select", id: added.id, panel: "settings" });
      focusEdit(added.id);
    },
    [commit, focusEdit],
  );

  /** Deleting a step in the Steps view moves focus to the previous step's Edit button. */
  const deleteStep = useCallback(
    (stepId: string) => {
      const rows = outlineRows(stateRef.current.graph).filter((r) => r.kind !== "label");
      const index = rows.findIndex((r) => r.node.id === stepId);
      const previous = index > 0 ? rows[index - 1] : null;
      commit(removeStep(stateRef.current.graph, stepId), stateRef.current.selected === stepId ? null : undefined);
      if (previous !== null) focusEdit(previous.node.id);
    },
    [commit, focusEdit],
  );

  const pickProblem = useCallback(
    (nodeId: string | null) => {
      if (nodeId === null) {
        dispatch({ type: "select", id: null, panel: "settings" });
        return;
      }
      dispatch({ type: "select", id: nodeId, panel: "settings" });
      if (view === "canvas") setFocusRequest({ id: nodeId, nonce: ++nonce.current });
      else focusEdit(nodeId);
    },
    [view, focusEdit],
  );

  /* ---- saving and the rest, all behind the operator token ---- */

  const reload = useCallback(
    async (status: Status) => {
      const result = await getAutomation(id);
      if (result.ok) {
        seeded.current = result.data.id + result.data.version;
        dispatch({ type: "load", detail: result.data, status });
      } else dispatch({ type: "status", status: { kind: "error", text: result.error } });
    },
    [id],
  );

  const save = useCallback(() => {
    const s = stateRef.current;
    if (s.saved === null || busy) return;
    flushBurst();
    const secrets: NonNullable<SaveAutomationBody["secrets"]> = {};
    for (const [nodeId, edit] of Object.entries(s.secretEdits)) {
      const entry: { url?: string | null; signing_secret?: string | null } = {};
      if (edit.url !== undefined && edit.url !== "") entry.url = edit.url;
      if (edit.signing_secret !== undefined && edit.signing_secret !== "") entry.signing_secret = edit.signing_secret;
      if (Object.keys(entry).length > 0) secrets[nodeId] = entry;
    }
    dispatch({ type: "status", status: { kind: "saving", text: "Saving..." } });
    const version = s.saved.version;
    run(
      "to save",
      (token) => saveAutomation(id, { name: s.name, graph: s.graph, version, secrets }, token),
      (result) => {
        if (result.ok) void reload({ kind: "saved", text: result.data.turned_off ? "Saved. The automation was turned off because it has problems." : `Saved at ${timeOf(new Date())}` });
        else if (result.status === 409) dispatch({ type: "status", status: { kind: "error", text: result.error } });
        else dispatch({ type: "status", status: { kind: "error", text: result.error } });
      },
    );
  }, [busy, flushBurst, id, reload, run]);

  const toggleEnabled = useCallback(() => {
    const s = stateRef.current;
    if (s.saved === null) return;
    const next = !s.saved.enabled;
    setProblemsNotice(null);
    run(
      next ? "to turn it on" : "to turn it off",
      (token) => setAutomationEnabled(id, next, token),
      (result) => {
        if (result.ok) void reload({ kind: "saved", text: next ? "Turned on." : "Turned off." });
        else {
          setProblemsNotice(result.error);
          void reload({ kind: "error", text: result.error });
        }
      },
    );
  }, [id, reload, run]);

  const startTest = useCallback(
    (input: { runId: string | null; send: boolean }) => {
      setTestError(null);
      testToken.run(
        "to run a test",
        (token) => testAutomation(id, { run_id: input.runId, send: input.send }, token),
        (result) => {
          if (result.ok) {
            setTestOpen(false);
            setOpenExecution(result.data.executionId);
            setHistoryKey((k) => k + 1);
            dispatch({ type: "panel", panel: "history" });
          } else setTestError(result.error);
        },
      );
    },
    [id, testToken],
  );

  const deleteWhole = useCallback(() => {
    if (!window.confirm("Delete this automation? It and its history are removed.")) return;
    run(
      "to delete it",
      (token) => deleteAutomation(id, token),
      (result) => {
        if (result.ok) router.push("/automations");
        else dispatch({ type: "status", status: { kind: "error", text: result.error } });
      },
    );
  }, [id, router, run]);

  /* ---- keyboard, leaving ---- */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        if (stateRef.current.saved !== null) save();
        return;
      }
      if (isTextTarget(e.target)) return; // a text field keeps its own undo
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, undo, redo]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /* ---- states without an editor ---- */

  if (loading || (saved === null && loaded !== null)) return <p role="status" className="text-sm text-muted-foreground">Loading the automation...</p>;
  if (saved === null) {
    const missing = loadError instanceof ApiFailure && loadError.status === 404;
    return missing ? (
      <EmptyState title="Automation not found" description="It may have been deleted." action={<Button asChild variant="outline" size="lg"><Link href="/automations">Back to automations</Link></Button>} />
    ) : (
      <ErrorState title="Could not load this automation" message={loadError?.message ?? "No data was received."} onRetry={() => void refresh()} />
    );
  }

  const selectedNode = state.selected === null ? null : (nodeById(graph, state.selected) ?? null);
  const overlayStep = selectedNode !== null && state.overlay !== null ? (state.overlay.steps.find((s) => s.node_id === selectedNode.id) ?? null) : null;
  const trigger = graph.nodes.find((n) => n.type.startsWith("trigger."));
  const triggerKind = trigger === undefined ? "run_finished" : (trigger.type.replace("trigger.", "") as "run_finished" | "review_saved" | "schedule");
  const hasSending = graph.nodes.some((n) => NODE_SPECS[n.type].hasUrl);
  const canTurnOn = !dirty && problems.length === 0;
  const switchReason = dirty ? "Save first" : problems.length > 0 && !saved.enabled ? "Fix the problems first" : null;
  const shownGraph = state.overlay?.graph ?? graph;

  const header = (
    <div className="space-y-3">
      <Link
        href="/automations"
        onClick={(e) => {
          if (dirty && !window.confirm("Leave without saving your changes?")) e.preventDefault();
        }}
        className="inline-flex min-h-6 items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Automations
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setRenaming(false);
              }}
            >
              <label htmlFor="automation-name" className="sr-only">
                Automation name
              </label>
              <Input
                id="automation-name"
                autoFocus
                value={state.name}
                maxLength={60}
                onChange={(e) => dispatch({ type: "name", name: e.target.value })}
                onBlur={() => setRenaming(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    dispatch({ type: "name", name: saved.name });
                    setRenaming(false);
                  }
                }}
                className="h-10 text-xl font-semibold"
              />
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight break-words">{state.name}</h1>
              <Button type="button" variant="outline" size="sm" onClick={() => setRenaming(true)} className="h-8 px-3">
                <Pencil aria-hidden="true" />
                Rename<span className="sr-only"> this automation</span>
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className={cn("text-sm", state.status.kind === "error" ? "text-reject" : "text-muted-foreground")}>
            {state.status.kind === "saving" ? "Saving..." : state.status.text !== "" ? state.status.text : dirty ? "Unsaved changes" : `Version ${saved.version}`}
          </span>
          <Button type="button" variant="outline" size="lg" disabled={state.past.length === 0 || readOnly} onClick={undo} className="h-9 px-3">
            <Undo2 aria-hidden="true" />
            Undo
          </Button>
          <Button type="button" variant="outline" size="lg" disabled={state.future.length === 0 || readOnly} onClick={redo} className="h-9 px-3">
            <Redo2 aria-hidden="true" />
            Redo
          </Button>
          <Button type="button" variant="outline" size="lg" disabled={dirty || busy} onClick={() => { setTestError(null); setTestOpen(true); }} className="h-9 px-3">
            <FlaskConical aria-hidden="true" />
            Test with an invoice
          </Button>
          <span className="flex flex-col items-start gap-0.5">
            <Switch enabled={saved.enabled} name={state.name} disabled={busy || (!saved.enabled && !canTurnOn) || (saved.enabled && dirty)} onToggle={toggleEnabled} />
            {switchReason !== null ? <span className="text-sm text-muted-foreground">{switchReason}</span> : null}
          </span>
          <Button type="button" size="lg" disabled={!dirty || busy || readOnly} onClick={save} className="h-9 px-4">
            <Save aria-hidden="true" />
            Save
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {problems.length > 0 ? (
          <button type="button" onClick={() => dispatch({ type: "select", id: null, panel: "settings" })} className="min-h-6 rounded-sm text-sm font-medium text-reject underline underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            {problems.length} {problems.length === 1 ? "problem" : "problems"}
          </button>
        ) : null}
        <details className="text-sm">
          <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm font-medium underline-offset-4 hover:underline">Keyboard shortcuts</summary>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            <li>Ctrl or ⌘ + S: save</li>
            <li>Ctrl or ⌘ + Z: undo; Ctrl or ⌘ + Shift + Z or Ctrl + Y: redo (not while typing in a field)</li>
            <li>Delete: remove the selected step or connection (canvas)</li>
          </ul>
        </details>
      </div>
      {problemsNotice ? <p role="alert" className="text-sm text-reject">{problemsNotice}</p> : null}
      {state.status.kind === "error" && state.status.text.startsWith("Someone else saved") ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-reject">
          {state.status.text}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (!dirty || window.confirm("Reloading drops your unsaved changes. Continue?")) void reload({ kind: "idle", text: "" });
            }}
            className="h-8 px-3"
          >
            Reload
          </Button>
        </p>
      ) : null}
      {prompt}
    </div>
  );

  const panelBody =
    state.panel === "history" ? (
      <HistoryPanel
        automationId={id}
        openId={openExecution}
        refreshKey={historyKey}
        onOverlay={setOverlay}
      />
    ) : (
      <Inspector
        ref={headingRef}
        node={selectedNode}
        graph={graph}
        detail={saved}
        secretEdits={state.secretEdits}
        available={selectedNode === null ? undefined : sources?.get(selectedNode.id)}
        problems={problems}
        readOnly={readOnly}
        overlayStep={overlayStep}
        onRename={(nodeId, name) => liveChange(renameStep(stateRef.current.graph, nodeId, name))}
        onConfig={(nodeId, config) => liveChange(setConfig(stateRef.current.graph, nodeId, config))}
        onDuplicate={(nodeId) => {
          const copy = duplicateStep(stateRef.current.graph, nodeId);
          if (copy !== null) {
            commit(copy.graph, copy.id);
            focusEdit(copy.id);
          }
        }}
        onDelete={deleteStep}
        onReplaceTrigger={(type) => commit(replaceTrigger(stateRef.current.graph, type as (typeof TRIGGER_TYPES)[number]))}
        onSecretEdit={(nodeId, edit) => dispatch({ type: "secret", nodeId, edit })}
        onPickProblem={pickProblem}
        onDeleteAutomation={deleteWhole}
      />
    );

  return (
    <div className="space-y-4">
      {header}

      <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)_22rem]">
        {wide ? (
          <aside className="min-w-0">
            <Palette onAdd={addFromPalette} disabled={readOnly} />
          </aside>
        ) : null}

        <div className="min-w-0 space-y-3">
          {wide ? (
            <div role="group" aria-label="View" className="flex flex-wrap items-center gap-2">
              {(
                [
                  ["canvas", "Canvas"],
                  ["steps", "Steps"],
                ] as const
              ).map(([value, word]) => (
                <Button key={value} type="button" size="sm" variant={view === value ? "default" : "outline"} aria-pressed={view === value} onClick={() => dispatch({ type: "view", view: value })} className="h-8 px-3">
                  {word}
                </Button>
              ))}
              {view === "canvas" ? (
                <button type="button" onClick={() => dispatch({ type: "view", view: "steps" })} className="min-h-6 rounded-sm text-sm font-medium underline underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
                  Use the Steps view (works with a screen reader)
                </button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">The canvas opens on wider screens. Every change can be made here.</p>
          )}

          {view === "canvas" ? (
            <div className="h-[min(70vh,44rem)]">
              <Canvas
                graph={shownGraph}
                selected={state.selected}
                problems={problems}
                overlay={state.overlay}
                focusRequest={focusRequest}
                onSelect={(sid) => dispatch({ type: "select", id: sid })}
                onStatus={(text) => dispatch({ type: "status", status: { kind: "error", text } })}
                onConnect={(source, handle, target) => {
                  const result = connect(stateRef.current.graph, source, handle, target);
                  if (!result.ok) return result.error;
                  commit(result.graph);
                  return null;
                }}
                onMoveEnd={(moves) => commit(moves.reduce((g, m) => setPosition(g, m.id, m.x, m.y), stateRef.current.graph))}
                onDeleteSteps={(ids) => commit(ids.reduce((g, sid) => removeStep(g, sid), stateRef.current.graph), null)}
                onDeleteEdges={(ids) => commit(ids.reduce((g, eid) => removeEdge(g, eid), stateRef.current.graph))}
                onDropStep={(type, x, y) => {
                  const added = addStepAt(stateRef.current.graph, type, x, y);
                  commit(added.graph, added.id);
                }}
              />
            </div>
          ) : (
            <StepsOutline
              graph={shownGraph}
              problems={problems}
              selected={state.selected}
              readOnly={readOnly}
              onEdit={(sid) => {
                dispatch({ type: "select", id: sid, panel: "settings" });
                requestAnimationFrame(() => headingRef.current?.focus());
              }}
              onAddAfter={(parentId, output, type) => {
                const added = addStepAfter(stateRef.current.graph, parentId, output, type);
                commit(added.graph, added.id);
                dispatch({ type: "select", id: added.id, panel: "settings" });
                focusEdit(added.id);
              }}
              onConnectAfter={(parentId, output, targetId) => {
                const result = connect(stateRef.current.graph, parentId, output, targetId);
                if (result.ok) {
                  commit(result.graph);
                  focusEdit(targetId);
                } else dispatch({ type: "status", status: { kind: "error", text: result.error } });
              }}
              onDelete={deleteStep}
              onDisconnect={(edgeId) => commit(removeEdge(stateRef.current.graph, edgeId))}
            />
          )}
        </div>

        <aside className="min-w-0 space-y-3">
          <div role="group" aria-label="Panel" className="flex flex-wrap gap-2">
            {(
              [
                ["settings", "Settings"],
                ["history", "History"],
              ] as const
            ).map(([value, word]) => (
              <Button key={value} type="button" size="sm" variant={state.panel === value ? "default" : "outline"} aria-pressed={state.panel === value} onClick={() => dispatch({ type: "panel", panel: value })} className="h-8 px-3">
                {word}
              </Button>
            ))}
          </div>
          <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">{panelBody}</div>
        </aside>
      </div>

      <TestDialog
        open={testOpen}
        triggerType={triggerKind}
        hasSending={hasSending}
        sendingEnabled={saved.sending_enabled}
        busy={testToken.busy}
        error={testError}
        prompt={testToken.prompt}
        onClose={() => {
          testToken.cancel();
          setTestOpen(false);
        }}
        onRun={startTest}
      />
    </div>
  );
}
