"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DECISION_WORDS,
  OPS_BY_TYPE,
  OP_WORDS,
  VARIABLES,
  isVarName,
  shortLabel,
  type Condition,
  type ConditionOp,
  type VarName,
  type VarSource,
} from "@/lib/workflow-graph";

const SELECT = "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

const SOURCE_TITLE: Record<VarSource, string> = {
  run: "The invoice",
  review: "The review",
  vendor: "The vendor (looked up)",
  po: "The PO (looked up)",
  summary: "The summary",
  always: "Always available",
};
const SOURCE_ORDER: readonly VarSource[] = ["run", "review", "vendor", "po", "summary", "always"];

/** The values a condition may test: available at this step, and of a kind that has operators (a date has none). */
function fields(available: ReadonlySet<VarSource>, current: string): { source: VarSource; names: VarName[] }[] {
  const names = (Object.keys(VARIABLES) as VarName[]).filter((n) => OPS_BY_TYPE[VARIABLES[n].type].length > 0 && (VARIABLES[n].source === "always" || available.has(VARIABLES[n].source) || n === current));
  return SOURCE_ORDER.map((source) => ({ source, names: names.filter((n) => VARIABLES[n].source === source) })).filter((g) => g.names.length > 0);
}

/** A starting operator and value for a value that was just chosen. */
export function defaultFor(field: string): Pick<Condition, "op" | "value"> {
  if (!isVarName(field)) return { op: "is", value: "" };
  const type = VARIABLES[field].type;
  const op = OPS_BY_TYPE[type][0] ?? "is";
  switch (type) {
    case "money":
    case "count":
      return { op, value: 0 };
    case "yesno":
      return { op, value: null };
    case "decision":
      return { op, value: "HOLD" };
    case "review_action":
      return { op, value: "APPROVE" };
    default:
      return { op, value: "" };
  }
}

export interface ConditionRowProps {
  index: number;
  condition: Condition;
  available: ReadonlySet<VarSource>;
  onChange: (next: Condition) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled?: boolean;
}

/**
 * One line of an If step: a value, an operator that suits it, and what to compare with (a choice for a decision, a number
 * for an amount or a count, nothing for a yes/no, text otherwise). Every control has a visible label (screen-reader text
 * says which condition it belongs to).
 */
export function ConditionRow({ index, condition, available, onChange, onRemove, canRemove, disabled = false }: ConditionRowProps) {
  const uid = useId();
  const known = isVarName(condition.field);
  const type = known ? VARIABLES[condition.field as VarName].type : "text";
  const ops: readonly ConditionOp[] = known ? OPS_BY_TYPE[type] : [];
  return (
    <fieldset className="space-y-2 rounded-lg p-2 ring-1 ring-foreground/10" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Condition {index + 1}</legend>
      <div className="space-y-1">
        <label htmlFor={`${uid}-field`} className="text-sm">
          Value
        </label>
        <select
          id={`${uid}-field`}
          value={condition.field}
          onChange={(e) => onChange({ field: e.target.value, ...defaultFor(e.target.value) })}
          className={SELECT}
        >
          {!known ? <option value={condition.field}>{condition.field} (unknown)</option> : null}
          {fields(available, condition.field).map((g) => (
            <optgroup key={g.source} label={SOURCE_TITLE[g.source]}>
              {g.names.map((n) => (
                <option key={n} value={n}>
                  {shortLabel(VARIABLES[n].label)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${uid}-op`} className="text-sm">
          Is
        </label>
        <select id={`${uid}-op`} value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as ConditionOp })} className={SELECT}>
          {ops.length === 0 ? <option value={condition.op}>{OP_WORDS[condition.op]}</option> : null}
          {ops.map((op) => (
            <option key={op} value={op}>
              {OP_WORDS[op]}
            </option>
          ))}
        </select>
      </div>
      {type === "yesno" ? null : (
        <div className="space-y-1">
          <label htmlFor={`${uid}-value`} className="text-sm">
            Compared with
          </label>
          {type === "decision" || type === "review_action" ? (
            <select id={`${uid}-value`} value={String(condition.value ?? "")} onChange={(e) => onChange({ ...condition, value: e.target.value })} className={SELECT}>
              {Object.entries(DECISION_WORDS)
                .filter(([token]) => type === "decision" || token !== "HOLD")
                .map(([token, word]) => (
                  <option key={token} value={token}>
                    {word}
                  </option>
                ))}
            </select>
          ) : type === "money" || type === "count" ? (
            <Input
              id={`${uid}-value`}
              type="number"
              inputMode="decimal"
              step="any"
              value={typeof condition.value === "number" ? condition.value : ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value === "" ? 0 : Number(e.target.value) })}
              className="h-9"
            />
          ) : (
            <Input id={`${uid}-value`} value={typeof condition.value === "string" ? condition.value : ""} maxLength={200} onChange={(e) => onChange({ ...condition, value: e.target.value })} className="h-9" />
          )}
        </div>
      )}
      {canRemove ? (
        <Button type="button" variant="outline" size="sm" onClick={onRemove} className="h-8 px-3">
          Remove<span className="sr-only"> condition {index + 1}</span>
        </Button>
      ) : null}
    </fieldset>
  );
}
