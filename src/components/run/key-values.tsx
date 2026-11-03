import type { ReactNode } from "react";
import { cn } from "cn";
import { DecisionBadge } from "@/components/shared/decision-badge";
import { DECISIONS, type Decision, type StageKey } from "@/lib/types";
import { boolEmphasis, kindOf, labelFor, wordFor, type Emphasis } from "./evidence-model";
import {
  displayText,
  formatBytes,
  formatCost,
  formatCount,
  formatDuration,
  formatMoney,
  formatPercent,
  isRecord,
} from "./run-format";

/** Nested objects deeper than this are not drawn (the raw-data view still has them). */
const MAX_DEPTH = 3;
/** At most this many entries of a list are drawn; the rest is counted. */
const MAX_ITEMS = 25;

const isDecision = (v: string): v is Decision => (DECISIONS as readonly string[]).includes(v);

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

const EMPHASIS_CLASS: Record<Emphasis, string> = {
  good: "font-medium text-approve",
  bad: "font-medium text-reject",
  warn: "font-medium text-hold",
  security: "font-medium text-security",
};

function BoolValue({ name, value }: { name: string; value: boolean }) {
  const emphasis = boolEmphasis(name, value);
  return <span className={emphasis ? EMPHASIS_CLASS[emphasis] : undefined}>{value ? "Yes" : "No"}</span>;
}

function NumberValue({ name, value }: { name: string; value: number }) {
  const kind = kindOf(name);
  let text: string;
  switch (kind) {
    case "money":
      text = formatMoney(value, null) ?? String(value);
      break;
    case "precise-money":
      text = formatMoney(value, null, { precise: true }) ?? String(value);
      break;
    case "percent":
      text = formatPercent(value);
      break;
    case "confidence":
      text = value.toFixed(2);
      break;
    case "duration":
      text = formatDuration(value) ?? String(value);
      break;
    case "bytes":
      text = formatBytes(value);
      break;
    case "cost":
      text = formatCost(value);
      break;
    case "count":
      text = formatCount(value);
      break;
    default:
      text = String(value);
  }
  return <span className="tabular-nums">{text}</span>;
}

function TextValue({ name, value }: { name: string; value: string }) {
  if (isDecision(value) && (name === "decision" || name === "original_decision")) {
    return <DecisionBadge decision={value} size="sm" />;
  }
  if (kindOf(name) === "hash") {
    const hash = displayText(value, 128);
    return <code className="font-mono text-xs break-all">{hash || "(empty)"}</code>;
  }
  const word = wordFor(name, value);
  if (word !== null) return <span>{word}</span>;
  const text = displayText(value, 1500);
  return text === "" ? <Muted>(empty)</Muted> : <span>{text}</span>;
}

function isPlain(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function ArrayValue({ stage, name, items, depth }: { stage: StageKey | null; name: string; items: unknown[]; depth: number }) {
  if (items.length === 0) return <Muted>None</Muted>;
  const shown = items.slice(0, MAX_ITEMS);
  const hidden = items.length - shown.length;
  const more = hidden > 0 ? <p className="mt-1 text-xs text-muted-foreground">{`and ${hidden} more (see the raw data)`}</p> : null;

  if (shown.every(isPlain)) {
    const compact = shown.every((v) => typeof v !== "string" || v.length <= 48);
    if (compact) {
      return (
        <>
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((v, i) => (
              <li key={i} className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs break-words">
                {typeof v === "string" ? (wordFor(name, v) ?? (displayText(v, 100) || "(empty)")) : v === null ? "none" : String(v)}
              </li>
            ))}
          </ul>
          {more}
        </>
      );
    }
    return (
      <>
        <ul className="list-disc space-y-1 pl-5">
          {shown.map((v, i) => (
            <li key={i}>
              <ValueView stage={stage} name={name} value={v} depth={depth + 1} />
            </li>
          ))}
        </ul>
        {more}
      </>
    );
  }

  return (
    <>
      <ol className="space-y-2">
        {shown.map((v, i) => (
          <li key={i} className="rounded-md border border-border bg-card p-2.5">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">{`#${i + 1}`}</p>
            <ValueView stage={stage} name={name} value={v} depth={depth + 1} />
          </li>
        ))}
      </ol>
      {more}
    </>
  );
}

/** Any JSON value as readable, plain-text markup: primitives with their units, lists as chips or bullets, objects as nested key-value rows. */
export function ValueView({ stage, name, value, depth = 0 }: { stage: StageKey | null; name: string; value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined) return <Muted>None</Muted>;
  if (typeof value === "string") return <TextValue name={name} value={value} />;
  if (typeof value === "number") return <NumberValue name={name} value={value} />;
  if (typeof value === "boolean") return <BoolValue name={name} value={value} />;
  if (Array.isArray(value)) return <ArrayValue stage={stage} name={name} items={value} depth={depth} />;
  if (isRecord(value)) {
    if (depth >= MAX_DEPTH) return <Muted>(more nested data: see the raw data)</Muted>;
    return <KeyValueList stage={stage} data={value} depth={depth + 1} />;
  }
  return <Muted>(a value that cannot be shown)</Muted>;
}

export interface KeyValueListProps {
  /** The stage the data belongs to (some keys are worded differently per stage); null for data of no stage. */
  stage: StageKey | null;
  data: Record<string, unknown>;
  /** Top-level keys that something else already shows (they are not repeated here). */
  omit?: ReadonlySet<string>;
  /** Top-level keys that are left out only while they are empty (null, "", [] or {}): "nothing" is noise for these. */
  hideEmpty?: ReadonlySet<string>;
  depth?: number;
  className?: string;
}

const isEmptyValue = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (isRecord(v) && Object.keys(v).length === 0);

/**
 * The generic evidence renderer: every key of `data` as a label and a value, in the order the stage wrote them.
 * Known keys get humane labels and units, unknown ones a tidied-up version of their name, so a key added to a
 * stage later still shows up. Everything is React text (never HTML) and every string is sanitised first.
 */
export function KeyValueList({ stage, data, omit, hideEmpty, depth = 0, className }: KeyValueListProps) {
  const entries = Object.entries(data)
    .filter(([key, value]) => !omit?.has(key) && !(hideEmpty?.has(key) && isEmptyValue(value)))
    .slice(0, MAX_ITEMS * 2);
  if (entries.length === 0) return null;
  return (
    <dl className={cn("space-y-2", depth > 0 && "border-l-2 border-border pl-3", className)}>
      {entries.map(([key, value]) => (
        <div key={key} className={cn("grid gap-x-4 gap-y-0.5", depth === 0 && "sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]")}>
          <dt className="text-sm text-muted-foreground">{labelFor(stage, key)}</dt>
          <dd className="min-w-0 text-sm break-words [overflow-wrap:anywhere]">
            <ValueView stage={stage} name={key} value={value} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
