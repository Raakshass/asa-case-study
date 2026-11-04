"use client";

import { useId, useRef } from "react";
import { Input } from "@/components/ui/input";
import { VARIABLES, shortLabel, type VarName, type VarSource } from "@/lib/workflow-graph";
import { previewTemplate } from "../preview-values";

const SOURCE_TITLE: Record<VarSource, string> = {
  run: "The invoice",
  review: "The review",
  vendor: "The vendor (looked up)",
  po: "The PO (looked up)",
  summary: "The summary",
  always: "Always available",
};
const SOURCE_ORDER: readonly VarSource[] = ["run", "review", "vendor", "po", "summary", "always"];

const FIELD = "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

/** The values a step may insert: those whose source is available at this step, grouped by where they come from. */
function groups(available: ReadonlySet<VarSource>): { source: VarSource; names: VarName[] }[] {
  const names = Object.keys(VARIABLES) as VarName[];
  return SOURCE_ORDER.filter((s) => s === "always" || available.has(s))
    .map((source) => ({ source, names: names.filter((n) => VARIABLES[n].source === source) }))
    .filter((g) => g.names.length > 0);
}

export interface TemplateFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** the value sources available at this step (the editor computes them from the connections) */
  available: ReadonlySet<VarSource>;
  maxLength: number;
  /** a one-line input instead of a text area (a webhook field) */
  singleLine?: boolean;
  disabled?: boolean;
  /** an accessible name when the visible label is shared by several fields */
  ariaLabel?: string;
}

/**
 * A text with {{values}} in it: the field, an "Insert a value" list of what is available at this step (by its plain
 * label; choosing one inserts {{name}} at the cursor), and a live preview with fixed sample values. Plain text only.
 */
export function TemplateField({ label, value, onChange, available, maxLength, singleLine = false, disabled = false, ariaLabel }: TemplateFieldProps) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const line = useRef<HTMLInputElement>(null);

  function insert(name: VarName, details: HTMLDetailsElement | null) {
    const el = singleLine ? line.current : area.current;
    const token = `{{${name}}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`.slice(0, maxLength);
    onChange(next);
    details?.removeAttribute("open");
    // put the cursor after the inserted value once React has drawn the new text
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {singleLine ? (
        <Input ref={line} id={id} value={value} maxLength={maxLength} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)} className="h-9" />
      ) : (
        <textarea ref={area} id={id} value={value} rows={4} maxLength={maxLength} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)} className={`${FIELD} min-h-24`} />
      )}
      <details className="text-sm">
        <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm font-medium text-foreground underline-offset-4 hover:underline">Insert a value</summary>
        <div className="mt-1 max-h-56 space-y-2 overflow-auto rounded-lg bg-card p-2 ring-1 ring-foreground/10">
          {groups(available).map((g) => (
            <div key={g.source}>
              <p className="text-sm font-semibold">{SOURCE_TITLE[g.source]}</p>
              <ul>
                {g.names.map((name) => (
                  <li key={name}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={(e) => insert(name, e.currentTarget.closest("details"))}
                      className="min-h-6 w-full rounded-sm px-1 py-0.5 text-left text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {shortLabel(VARIABLES[name].label)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
      <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
        <span className="font-medium">Preview with sample values: </span>
        {previewTemplate(value) || "(empty)"}
      </p>
    </div>
  );
}
