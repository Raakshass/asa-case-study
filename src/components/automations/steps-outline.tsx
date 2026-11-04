"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NODE_SPECS, isTriggerType, summarizeStep, type Graph, type GraphProblem, type NodeType } from "@/lib/workflow-graph";
import { incoming, outlineRows, outputLabel, type OutlineRow } from "./graph-edit";
import { NODE_ICON, PALETTE_GROUPS } from "./palette";

export interface StepsOutlineProps {
  graph: Graph;
  problems: GraphProblem[];
  selected: string | null;
  readOnly: boolean;
  onEdit: (id: string) => void;
  onAddAfter: (parentId: string, output: string, type: NodeType) => void;
  /** connect a loose step after `parentId`'s `output` */
  onConnectAfter: (parentId: string, output: string, targetId: string) => void;
  onDelete: (id: string) => void;
  onDisconnect: (edgeId: string) => void;
}

/** Closes the <details> menu a button sits in once it was used. */
const closeMenu = (el: HTMLElement): void => el.closest("details")?.removeAttribute("open");

const SUMMARY = "inline-flex h-8 min-w-8 cursor-pointer items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";
const MENU = "absolute z-10 mt-1 max-h-72 min-w-56 space-y-1 overflow-auto rounded-lg bg-card p-2 shadow-md ring-1 ring-foreground/15";
const ITEM = "min-h-6 w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

/** The step types that can be added, as menu items. */
function AddItems({ onPick }: { onPick: (type: NodeType) => void }) {
  return (
    <>
      {PALETTE_GROUPS.map((g) => (
        <div key={g.title}>
          <p className="px-2 text-sm font-semibold text-muted-foreground">{g.title}</p>
          {g.types.map((type) => (
            <button
              key={type}
              type="button"
              className={ITEM}
              onClick={(e) => {
                closeMenu(e.currentTarget);
                onPick(type);
              }}
            >
              {NODE_SPECS[type].label}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * The Steps view (plan 8.2): the whole automation as an ordered list, a tree drawn from the starting step. It can do
 * everything the canvas can except drag positions, and it is the keyboard and screen-reader path. Every action is a real
 * button or a native <details> menu; the buttons carry data attributes so the editor can move focus after a change.
 */
export function StepsOutline({ graph, problems, selected, readOnly, onEdit, onAddAfter, onConnectAfter, onDelete, onDisconnect }: StepsOutlineProps) {
  const rows = outlineRows(graph);
  const problemsOf = (id: string): GraphProblem[] => problems.filter((p) => p.node_id === id);
  const stepRows = rows.filter((r): r is Extract<OutlineRow, { kind: "step" | "loose" }> => r.kind !== "label");

  function actions(id: string, loose: boolean) {
    const node = graph.nodes.find((n) => n.id === id);
    if (node === undefined) return null;
    const outputs = NODE_SPECS[node.type].outputs;
    const ins = incoming(graph, id);
    const trigger = isTriggerType(node.type);
    return (
      <div className="flex flex-wrap items-start gap-2">
        <Button type="button" variant={selected === id ? "default" : "outline"} size="sm" data-edit={id} aria-pressed={selected === id} onClick={() => onEdit(id)} className="h-8 px-3">
          {readOnly ? "View" : "Edit"}
          <span className="sr-only"> {node.name}</span>
        </Button>
        {!readOnly ? (
          <>
            {!loose ? (
              <details className="relative">
                <summary className={SUMMARY}>
                  Add after<span className="sr-only"> {node.name}</span>
                </summary>
                <div className={MENU}>
                  {outputs.length > 1 ? (
                    outputs.map((o) => (
                      <details key={o.id} className="rounded-sm">
                        <summary className={`${ITEM} cursor-pointer font-medium`}>After {o.label}</summary>
                        <div className="pl-2">
                          <AddItems onPick={(type) => onAddAfter(id, o.id, type)} />
                        </div>
                      </details>
                    ))
                  ) : (
                    <AddItems onPick={(type) => onAddAfter(id, outputs[0].id, type)} />
                  )}
                </div>
              </details>
            ) : (
              <details className="relative">
                <summary className={SUMMARY}>
                  Connect after<span className="sr-only"> {node.name}</span>
                </summary>
                <div className={MENU}>
                  {graph.nodes
                    .filter((n) => n.id !== id)
                    .flatMap((n) => NODE_SPECS[n.type].outputs.map((o) => ({ n, o })))
                    .map(({ n, o }) => (
                      <button
                        key={`${n.id}-${o.id}`}
                        type="button"
                        className={ITEM}
                        onClick={(e) => {
                          closeMenu(e.currentTarget);
                          onConnectAfter(n.id, o.id, id);
                        }}
                      >
                        {n.name}
                        {outputLabel(n, o.id) !== "" ? ` (${outputLabel(n, o.id)})` : ""}
                      </button>
                    ))}
                </div>
              </details>
            )}
            {ins.length > 0 ? (
              <details className="relative">
                <summary className={SUMMARY}>
                  Disconnect<span className="sr-only"> {node.name}</span>
                </summary>
                <div className={MENU}>
                  {ins.map(({ edge, from }) => (
                    <button
                      key={edge.id}
                      type="button"
                      className={ITEM}
                      onClick={(e) => {
                        closeMenu(e.currentTarget);
                        onDisconnect(edge.id);
                      }}
                    >
                      From {from.name}
                      {outputLabel(from, edge.sourceHandle) !== "" ? ` (${outputLabel(from, edge.sourceHandle)})` : ""}
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
            {!trigger ? (
              <Button type="button" variant="outline" size="sm" data-delete={id} onClick={() => onDelete(id)} className="h-8 px-3">
                Delete<span className="sr-only"> {node.name}</span>
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <section aria-labelledby="steps-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="steps-heading" className="text-base font-semibold">
          Steps
        </h2>
        <p className="text-sm text-muted-foreground">{problems.length === 0 ? "No problems" : `${problems.length} ${problems.length === 1 ? "problem" : "problems"}`}</p>
      </div>
      {stepRows.length === 0 ? <p className="text-sm text-muted-foreground">This automation has no steps yet.</p> : null}
      <ol className="space-y-2" data-steps-list>
        {rows.map((row, i) => {
          if (row.kind === "label") {
            return (
              <li key={`l${i}`} aria-hidden="true" className="text-sm font-medium text-muted-foreground" style={{ paddingLeft: `${Math.min(row.depth, 6) * 1}rem` }}>
                {row.text}
              </li>
            );
          }
          const node = row.node;
          const Icon = NODE_ICON[node.type as NodeType];
          const mine = problemsOf(node.id);
          const loose = row.kind === "loose";
          return (
            <li
              key={node.id}
              data-step-row={node.id}
              className={`space-y-1.5 rounded-lg bg-card p-3 ring-1 ${mine.length > 0 ? "ring-reject-border" : "ring-foreground/10"}`}
              style={{ marginLeft: loose ? 0 : `${Math.min(row.kind === "step" ? row.depth : 0, 6) * 1}rem` }}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-sm text-muted-foreground tabular-nums">{row.number}</span>
                <Icon aria-hidden="true" className="size-4 shrink-0 self-center" />
                <span className="font-semibold break-words">{node.name}</span>
                <span className="text-sm break-words text-muted-foreground">{summarizeStep(node)}</span>
              </div>
              {row.kind === "step" && row.alsoFrom.length > 0 ? <p className="text-sm text-muted-foreground">Also reached from: {row.alsoFrom.join(", ")}</p> : null}
              {loose ? (
                <p className="flex items-start gap-1.5 text-sm text-reject">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  &ldquo;{node.name}&rdquo; ({row.number}) is not connected to the start.
                </p>
              ) : null}
              {mine
                .filter((p) => !(loose && p.message === "This step is not connected to the start."))
                .map((p, j) => (
                  <p key={j} className="text-sm text-reject">
                    {p.message}
                  </p>
                ))}
              {actions(node.id, loose)}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
