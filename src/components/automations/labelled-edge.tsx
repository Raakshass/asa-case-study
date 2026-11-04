"use client";

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps, type EdgeTypes } from "@xyflow/react";
import { cn } from "cn";

export interface LabelledEdgeData extends Record<string, unknown> {
  /** The output's words ("Yes", "On hold"); "" for a step with one output. */
  label: string;
  /** History overlay only: true = this connection was taken, false = it was not, null = no overlay. */
  taken: boolean | null;
}

export type LabelledEdgeType = Edge<LabelledEdgeData, "labelled">;

/**
 * A connection between two steps (plan 8.1): a smoothstep line, 1.5 px graphite (2 px ink when selected). A connection that leaves
 * a labelled output carries that label once, at its middle, in a small white chip with a rule around it: the one pill in the
 * app, allowed because it labels a line like an annotation on a form. With the history overlay a connection that was taken is
 * 2 px ink and the others are dashed. The styles are in src/app/automations/automations.css.
 *
 * The edge is not focusable (the canvas sets edgesFocusable to false), so the chip is decoration for the eye: the edge's own
 * aria-label, set by the canvas, already names the output.
 */
export function LabelledEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerStart, markerEnd, interactionWidth, data }: EdgeProps<LabelledEdgeType>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 });
  const label = data?.label ?? "";
  const taken = data?.taken ?? null;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
        className={cn(taken === true && "is-taken", taken === false && "is-not-taken")}
      />
      {label !== "" && (
        <EdgeLabelRenderer>
          <div
            aria-hidden="true"
            className={cn("automation-edge-label nodrag nopan", taken === false && "is-not-taken")}
            data-edge-label-for={id}
            style={{ position: "absolute", transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Registered at module level, so React Flow never sees a new object on a render. */
export const EDGE_TYPES_RF: EdgeTypes = { labelled: LabelledEdge };
