"use client";

import { forwardRef, useId, useMemo } from "react";
import { Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AutomationDetail, ExecutionStep } from "@/lib/types";
import {
  NODE_SPECS,
  TRIGGER_TYPES,
  VARIABLES,
  isTriggerType,
  shortLabel,
  type Condition,
  type Graph,
  type GraphNode,
  type GraphProblem,
  type NodeType,
  type VarName,
  type VarSource,
} from "@/lib/workflow-graph";
import { ConditionRow, defaultFor } from "./forms/condition-row";
import { SecretUrlField, type SecretEdit } from "./forms/secret-url-field";
import { TemplateField } from "./forms/template-field";
import { previewTemplate } from "./preview-values";

const SELECT = "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";
const CHECK = "flex min-h-6 items-center gap-2 text-sm";
const DECISION_BOXES = [
  ["APPROVE", "Approved"],
  ["HOLD", "On hold"],
  ["REJECT", "Rejected"],
] as const;

/** What a step adds for the steps after it, in words (the vendor and PO steps' forms list it). */
const addsTo = (source: VarSource): string[] => (Object.keys(VARIABLES) as VarName[]).filter((n) => VARIABLES[n].source === source).map((n) => shortLabel(VARIABLES[n].label));

type Config = Record<string, unknown>;

export interface InspectorProps {
  /** the selected step, or null */
  node: GraphNode | null;
  graph: Graph;
  detail: AutomationDetail;
  secretEdits: Record<string, SecretEdit>;
  /** the value sources available at the selected step */
  available: ReadonlySet<VarSource> | undefined;
  problems: GraphProblem[];
  /** a history execution is shown: nothing can be edited */
  readOnly: boolean;
  /** what the selected step did in the shown execution */
  overlayStep: ExecutionStep | null;
  onRename: (id: string, name: string) => void;
  onConfig: (id: string, config: Config) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onReplaceTrigger: (type: (typeof TRIGGER_TYPES)[number]) => void;
  onSecretEdit: (nodeId: string, edit: SecretEdit | undefined) => void;
  /** a problem was chosen: select its step (null: a problem about the whole automation) */
  onPickProblem: (nodeId: string | null) => void;
  onDeleteAutomation: () => void;
}

/** The problems list, each one a button that goes to its step. */
function ProblemList({ problems, nodeName, onPick }: { problems: GraphProblem[]; nodeName: (id: string | null) => string; onPick: (id: string | null) => void }) {
  if (problems.length === 0) return <p className="text-sm text-muted-foreground">No problems.</p>;
  return (
    <ul role="status" className="space-y-1.5">
      {problems.map((p, i) => (
        <li key={i}>
          <button type="button" onClick={() => onPick(p.node_id)} className="min-h-6 w-full rounded-sm px-1 py-0.5 text-left text-sm text-reject hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            <span className="font-medium">{nodeName(p.node_id)}: </span>
            {p.message}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The settings panel (plan 8.4): a form for the selected step, or with nothing selected the problems and "Delete this automation". */
export const Inspector = forwardRef<HTMLHeadingElement, InspectorProps>(function Inspector(props, headingRef) {
  const { node, graph, detail, secretEdits, available, problems, readOnly, overlayStep } = props;
  const uid = useId();
  const nodeName = (id: string | null): string => (id === null ? "This automation" : (graph.nodes.find((n) => n.id === id)?.name ?? id));
  const mine = useMemo(() => problems.filter((p) => node !== null && p.node_id === node.id), [problems, node]);

  if (node === null) {
    return (
      <div className="space-y-4">
        <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
          Settings
        </h2>
        <p className="text-sm text-muted-foreground">Select a step to change it.</p>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Problems ({problems.length})</h3>
          <ProblemList problems={problems} nodeName={nodeName} onPick={props.onPickProblem} />
        </div>
        {!readOnly ? (
          <div className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-semibold">Delete this automation</h3>
            <p className="text-sm text-muted-foreground">It and its history are removed. The notes and assignments it already made stay on the invoices.</p>
            <Button type="button" variant="outline" size="sm" onClick={props.onDeleteAutomation} className="h-8 px-3">
              <Trash2 aria-hidden="true" />
              Delete this automation
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const spec = NODE_SPECS[node.type];
  const config = node.config as Config;
  const set = (patch: Config): void => props.onConfig(node.id, { ...config, ...patch });
  const avail = available ?? new Set<VarSource>(["always"]);
  const trigger = isTriggerType(node.type);

  return (
    <div className="space-y-4">
      <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
        {spec.label}
      </h2>
      <p className="text-sm text-muted-foreground">{spec.description}</p>

      {mine.length > 0 ? (
        <ul role="status" className="space-y-1">
          {mine.map((p, i) => (
            <li key={i} className="text-sm text-reject">
              {p.message}
            </li>
          ))}
        </ul>
      ) : null}

      {readOnly ? (
        <OverlayOutput step={overlayStep} />
      ) : (
        <>
          <div className="space-y-1.5">
            <label htmlFor={`${uid}-name`} className="text-sm font-medium">
              Name
            </label>
            <Input id={`${uid}-name`} value={node.name} maxLength={60} onChange={(e) => props.onRename(node.id, e.target.value)} className="h-9" />
          </div>

          {trigger ? (
            <div className="space-y-1.5">
              <label htmlFor={`${uid}-trigger`} className="text-sm font-medium">
                Starting step
              </label>
              <select id={`${uid}-trigger`} value={node.type} onChange={(e) => props.onReplaceTrigger(e.target.value as (typeof TRIGGER_TYPES)[number])} className={SELECT}>
                {TRIGGER_TYPES.map((t) => (
                  <option key={t} value={t} disabled={t === "trigger.review_saved" && !detail.review_trigger_available}>
                    {NODE_SPECS[t].label}
                    {t === "trigger.review_saved" && !detail.review_trigger_available ? " (needs the human review feature)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <TypeForm type={node.type} config={config} set={set} avail={avail} detail={detail} nodeId={node.id} secretEdits={secretEdits} onSecretEdit={props.onSecretEdit} graph={graph} />

          {!trigger ? (
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button type="button" variant="outline" size="sm" onClick={() => props.onDuplicate(node.id)} className="h-8 px-3">
                <Copy aria-hidden="true" />
                Duplicate
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => props.onDelete(node.id)} className="h-8 px-3">
                <Trash2 aria-hidden="true" />
                Delete step
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
});

/** What a step did in the shown execution, instead of its settings. */
function OverlayOutput({ step }: { step: ExecutionStep | null }) {
  if (step === null) return <p className="text-sm text-muted-foreground">This step did not run in the execution shown.</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm">
        <span className="font-medium">Result: </span>
        {step.status === "success" ? "Succeeded" : step.status === "error" ? "Failed" : "Skipped"}
        {step.attempts > 1 ? `, ${step.attempts} attempts` : ""}
      </p>
      {step.error ? <p className="text-sm text-reject">{step.error}</p> : null}
      {step.output !== null && step.output !== undefined ? (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{JSON.stringify(step.output, null, 2).slice(0, 4000)}</pre>
      ) : null}
    </div>
  );
}

interface TypeFormProps {
  type: NodeType;
  config: Config;
  set: (patch: Config) => void;
  avail: ReadonlySet<VarSource>;
  detail: AutomationDetail;
  nodeId: string;
  secretEdits: Record<string, SecretEdit>;
  onSecretEdit: (nodeId: string, edit: SecretEdit | undefined) => void;
  graph: Graph;
}

function Checks({ legend, options, value, onChange }: { legend: string; options: readonly (readonly [string, string])[]; value: string[]; onChange: (next: string[]) => void }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{legend}</legend>
      {options.map(([token, word]) => (
        <label key={token} className={CHECK}>
          <input type="checkbox" checked={value.includes(token)} onChange={(e) => onChange(e.target.checked ? [...value, token] : value.filter((v) => v !== token))} className="size-4" />
          {word}
        </label>
      ))}
    </fieldset>
  );
}

function TypeForm({ type, config, set, avail, detail, nodeId, secretEdits, onSecretEdit, graph }: TypeFormProps) {
  const uid = useId();
  switch (type) {
    case "trigger.run_finished":
      return (
        <div className="space-y-2">
          <Checks legend="Start on" options={[...DECISION_BOXES, ["ERROR", "System error"]]} value={[...(config.decisions as string[]), ...(config.include_errors === true ? ["ERROR"] : [])]} onChange={(next) => set({ decisions: next.filter((v) => v !== "ERROR"), include_errors: next.includes("ERROR") })} />
        </div>
      );
    case "trigger.review_saved":
      return (
        <Checks
          legend="Start when a hold is"
          options={[
            ["APPROVE", "Approved"],
            ["REJECT", "Rejected"],
          ]}
          value={config.actions as string[]}
          onChange={(next) => set({ actions: next })}
        />
      );
    case "trigger.schedule": {
      const every = config.every as string;
      const hour = config.hour as number;
      const minute = config.minute as number;
      const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      const local = (() => {
        try {
          const d = new Date(Date.UTC(2026, 0, 1, hour, minute));
          return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(d);
        } catch {
          return time;
        }
      })();
      return (
        <div className="space-y-3">
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Runs</legend>
            {(
              [
                ["day", "Every day"],
                ["hour", "Every hour"],
              ] as const
            ).map(([value, word]) => (
              <label key={value} className={CHECK}>
                <input type="radio" name={`${uid}-every`} checked={every === value} onChange={() => set({ every: value })} className="size-4" />
                {word}
              </label>
            ))}
          </fieldset>
          {every === "day" ? (
            <div className="space-y-1.5">
              <label htmlFor={`${uid}-time`} className="text-sm font-medium">
                Time (UTC)
              </label>
              <Input
                id={`${uid}-time`}
                type="time"
                step={60}
                value={time}
                onChange={(e) => {
                  const m = /^(\d{2}):(\d{2})/.exec(e.target.value);
                  if (m) set({ hour: Number(m[1]), minute: Number(m[2]) });
                }}
                className="h-9 sm:max-w-40"
              />
              <p className="text-sm text-muted-foreground">
                Times are UTC. {time} UTC is {local} here.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor={`${uid}-minute`} className="text-sm font-medium">
                At minute
              </label>
              <Input id={`${uid}-minute`} type="number" min={0} max={59} value={minute} onChange={(e) => set({ minute: Math.min(59, Math.max(0, Math.trunc(Number(e.target.value) || 0))) })} className="h-9 sm:max-w-32" />
              <p className="text-sm text-muted-foreground">Times are UTC.</p>
            </div>
          )}
        </div>
      );
    }
    case "logic.if": {
      const conditions = config.conditions as Condition[];
      return (
        <div className="space-y-3">
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Go the Yes way when</legend>
            {(
              [
                ["all", "All of these"],
                ["any", "Any of these"],
              ] as const
            ).map(([value, word]) => (
              <label key={value} className={CHECK}>
                <input type="radio" name={`${uid}-combine`} checked={config.combine === value} onChange={() => set({ combine: value })} className="size-4" />
                {word}
              </label>
            ))}
          </fieldset>
          {conditions.map((c, i) => (
            <ConditionRow
              key={i}
              index={i}
              condition={c}
              available={avail}
              canRemove={conditions.length > 1}
              onChange={(next) => set({ conditions: conditions.map((x, j) => (j === i ? next : x)) })}
              onRemove={() => set({ conditions: conditions.filter((_, j) => j !== i) })}
            />
          ))}
          {conditions.length < 10 ? (
            <Button type="button" variant="outline" size="sm" onClick={() => set({ conditions: [...conditions, { field: "run.decision", ...defaultFor("run.decision") }] })} className="h-8 px-3">
              Add a condition
            </Button>
          ) : null}
        </div>
      );
    }
    case "logic.switch_decision":
      return <p className="text-sm">Goes one way for each decision. Connect the outputs you need; the others stop here.</p>;
    case "data.vendor":
    case "data.po_balance": {
      const source: VarSource = type === "data.vendor" ? "vendor" : "po";
      return (
        <div className="space-y-2">
          <p className="text-sm">{NODE_SPECS[type].description}</p>
          <p className="text-sm font-medium">Adds these values for the steps after it:</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {addsTo(source).map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      );
    }
    case "data.summarize":
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor={`${uid}-hours`} className="text-sm font-medium">
              Hours to look back
            </label>
            <Input id={`${uid}-hours`} type="number" min={1} max={168} value={config.window_hours as number} onChange={(e) => set({ window_hours: Math.min(168, Math.max(1, Math.trunc(Number(e.target.value) || 1))) })} className="h-9 sm:max-w-32" />
          </div>
          <Checks legend="Count invoices that are" options={DECISION_BOXES} value={config.decisions as string[]} onChange={(next) => set({ decisions: next })} />
          <div className="space-y-1.5">
            <label htmlFor={`${uid}-max`} className="text-sm font-medium">
              Most invoices listed
            </label>
            <Input id={`${uid}-max`} type="number" min={1} max={20} value={config.max_items as number} onChange={(e) => set({ max_items: Math.min(20, Math.max(1, Math.trunc(Number(e.target.value) || 1))) })} className="h-9 sm:max-w-32" />
          </div>
        </div>
      );
    case "action.note":
      return <TemplateField label="Note text" value={config.text as string} onChange={(text) => set({ text })} available={avail} maxLength={1000} />;
    case "action.assign": {
      const used = [...new Set(graph.nodes.filter((n) => n.type === "action.assign" && n.id !== nodeId).map((n) => String((n.config as Config).assignee ?? "")).filter((a) => a !== ""))];
      const names = [...new Set([...used, "AP lead", "AP clerk", "Finance security"])];
      return (
        <div className="space-y-1.5">
          <label htmlFor={`${uid}-assignee`} className="text-sm font-medium">
            Assign to
          </label>
          <Input id={`${uid}-assignee`} list={`${uid}-names`} value={config.assignee as string} maxLength={60} onChange={(e) => set({ assignee: e.target.value })} className="h-9" />
          <datalist id={`${uid}-names`}>
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
      );
    }
    case "action.webhook": {
      const fields = config.fields as { key: string; value: string }[];
      const body = JSON.stringify(
        { event: "invoice.decided", sent_at: "2026-11-03T10:42:00.000Z", automation: { id: "…", name: "…" }, execution_id: "…", data: Object.fromEntries(fields.map((f) => [f.key, previewTemplate(f.value)])) },
        null,
        2,
      );
      return (
        <div className="space-y-3">
          <SecretUrlField state={detail.secrets[nodeId]} edit={secretEdits[nodeId]} onEdit={(edit) => onSecretEdit(nodeId, edit)} allowedHosts={detail.allowed_hosts} sendingEnabled={detail.sending_enabled} />
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Fields to send</legend>
            {fields.map((f, i) => (
              <div key={i} className="space-y-2 rounded-lg p-2 ring-1 ring-foreground/10">
                <div className="space-y-1">
                  <label htmlFor={`${uid}-key-${i}`} className="text-sm">
                    Field {i + 1} name
                  </label>
                  <Input id={`${uid}-key-${i}`} value={f.key} maxLength={40} onChange={(e) => set({ fields: fields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} className="h-9 font-mono" />
                </div>
                <TemplateField label={`Field ${i + 1} value`} value={f.value} singleLine maxLength={2000} available={avail} onChange={(value) => set({ fields: fields.map((x, j) => (j === i ? { ...x, value } : x)) })} />
                <Button type="button" variant="outline" size="sm" onClick={() => set({ fields: fields.filter((_, j) => j !== i) })} className="h-8 px-3">
                  Remove<span className="sr-only"> field {i + 1}</span>
                </Button>
              </div>
            ))}
            {fields.length < 20 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => set({ fields: [...fields, { key: "", value: "" }] })} className="h-8 px-3">
                Add a field
              </Button>
            ) : null}
          </fieldset>
          <div className="space-y-1">
            <p className="text-sm font-medium">What is sent</p>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{body}</pre>
          </div>
        </div>
      );
    }
    case "action.chat":
      return (
        <div className="space-y-3">
          <SecretUrlField state={detail.secrets[nodeId]} edit={secretEdits[nodeId]} onEdit={(edit) => onSecretEdit(nodeId, edit)} allowedHosts={detail.allowed_hosts} sendingEnabled={detail.sending_enabled} />
          <TemplateField label="Message" value={config.text as string} onChange={(text) => set({ text })} available={avail} maxLength={2000} />
        </div>
      );
  }
}
