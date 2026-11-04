"use client";

import { useMemo } from "react";
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import {
  Building,
  CalendarClock,
  CircleAlert,
  GitBranch,
  Inbox,
  ListChecks,
  MessageSquareText,
  ReceiptText,
  Split,
  StickyNote,
  UserCheck,
  UserRound,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { StepStatusIcon } from "@/components/shared/step-status-icon";
import type { ExecutionStep, StepStatus } from "@/lib/types";
import { NODE_SPECS, summarizeStep, type GraphNode, type GraphProblem, type NodeType } from "@/lib/workflow-graph";

/** What the canvas hands to each card. Everything here is plain data; the card draws all of it as text. */
export interface StepCardData extends Record<string, unknown> {
  node: GraphNode;
  /** Only this step's problems. */
  problems: GraphProblem[];
  /** History overlay: what this step did in the shown execution; null when there is no overlay or the step has no row yet. */
  execStep: ExecutionStep | null;
  /** An execution is being shown. */
  overlay: boolean;
}

export type StepNode = Node<StepCardData, "step">;

/** One icon per step type. The shape tells the kind as well as the tile colour does, so colour is never the only signal. */
const ICONS: Record<NodeType, LucideIcon> = {
  "trigger.run_finished": Inbox,
  "trigger.schedule": CalendarClock,
  "trigger.review_saved": UserCheck,
  "logic.if": GitBranch,
  "logic.switch_decision": Split,
  "data.vendor": Building,
  "data.po_balance": ReceiptText,
  "data.summarize": ListChecks,
  "action.note": StickyNote,
  "action.assign": UserRound,
  "action.webhook": Webhook,
  "action.chat": MessageSquareText,
};

const EXEC_WORD: Record<ExecutionStep["status"], string> = { success: "Succeeded", error: "Failed", skipped: "Skipped" };
const EXEC_ICON: Record<ExecutionStep["status"], StepStatus> = { success: "pass", error: "fail", skipped: "skipped" };

/**
 * A step drawn as an index card (plan 8.1): a 28 px icon tile for the kind, the step's name, one line of what it does, and
 * (with the history overlay) what it did. Inputs are on the left and outputs on the right; a step that branches names each
 * output in words next to its handle. The styles are in src/app/automations/automations.css.
 *
 * The card's root is not a button: React Flow gives the node wrapper its own role and focus.
 */
export function StepCard({ data, selected, isConnectable }: NodeProps<StepNode>) {
  const { node, problems, execStep, overlay } = data;
  const spec = NODE_SPECS[node.type];
  const Icon = ICONS[node.type];
  const summary = useMemo(() => summarizeStep(node), [node]);
  const outputs = spec.outputs;
  const branching = outputs.length > 1;
  const isTrigger = spec.kind === "trigger";
  const hasProblems = problems.length > 0;
  const execAttr = execStep !== null ? execStep.status : overlay ? "not-run" : undefined;

  return (
    <div
      className="step-card"
      data-node-kind={spec.kind}
      data-node-type={node.type}
      data-step-id={node.id}
      data-selected={selected ? "true" : "false"}
      data-has-problems={hasProblems ? "true" : "false"}
      data-exec-status={execAttr}
    >
      {!isTrigger && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={isConnectable}
          isConnectableStart={false}
          role="img"
          aria-label={`Input of ${node.name}`}
        />
      )}

      <div className="step-card__main">
        <div className="step-card__head">
          <span className="step-card__tile" data-kind={spec.kind}>
            <Icon aria-hidden="true" size={16} strokeWidth={2} />
          </span>
          <span className="step-card__name line-clamp-2">{node.name}</span>
          {hasProblems && (
            <span className="step-card__alert">
              <CircleAlert aria-hidden="true" size={16} />
              <span className="sr-only">has problems</span>
            </span>
          )}
        </div>
        <p className="step-card__summary line-clamp-2">{summary}</p>
        {overlay && (
          <p className="step-card__status">
            {execStep !== null ? (
              <>
                <span aria-hidden="true" className="step-card__status-icon">
                  <StepStatusIcon status={EXEC_ICON[execStep.status]} size="sm" />
                </span>
                <span>{execStep.attempts > 1 ? `${EXEC_WORD[execStep.status]}, ${execStep.attempts} attempts` : EXEC_WORD[execStep.status]}</span>
              </>
            ) : (
              <>
                <span aria-hidden="true" className="step-card__status-icon">
                  <StepStatusIcon status="pending" size="sm" />
                </span>
                <span>Not run</span>
              </>
            )}
          </p>
        )}
      </div>

      {branching && (
        <div className="step-card__outputs">
          {outputs.map((output) => (
            <span key={output.id} className="step-card__output">
              {output.label}
            </span>
          ))}
        </div>
      )}

      {outputs.map((output, i) => (
        <Handle
          key={output.id}
          type="source"
          position={Position.Right}
          id={output.id}
          isConnectable={isConnectable}
          isConnectableEnd={false}
          role="img"
          aria-label={`Output ${output.label} of ${node.name}`}
          style={branching ? { top: `${((i + 0.5) / outputs.length) * 100}%` } : undefined}
        />
      ))}
    </div>
  );
}

/** Registered at module level, so React Flow never sees a new object on a render. */
export const NODE_TYPES_RF: NodeTypes = { step: StepCard };
