import { Fragment, type ReactNode } from "react";
import { LoaderCircle, Minus, TriangleAlert } from "lucide-react";
import { ConfidenceChip } from "@/components/shared/confidence-chip";
import { GroundedMark } from "@/components/shared/grounded-mark";
import { Ident } from "@/components/shared/ident";
import { TextSkeleton } from "@/components/shared/skeletons";
import { TableFrame } from "@/components/shared/table-frame";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  GROUNDED_FIELDS,
  type FieldGrounding,
  type GroundedField,
  type InvoiceExtraction,
  type RunDetail,
  type StepView,
} from "@/lib/types";
import { wordFor } from "./evidence-model";
import { Muted } from "./key-values";
import { asStrings, displayText, formatCount, formatMoney, isRecord } from "./run-format";

/* ------------------------------------------------------------------------------------------------ grounding state */

/**
 * What the grounded column can say, from the validate stage:
 * waiting (not finished), ready (a verdict per field), scanned (no text layer: grounding is null) or unavailable
 * (the stage was skipped or failed, so nothing was compared).
 */
export type Grounding =
  | { kind: "waiting" }
  | { kind: "ready"; fields: ReadonlyMap<GroundedField, FieldGrounding["status"]> }
  | { kind: "scanned" }
  | { kind: "unavailable" };

export function groundingOf(run: Pick<RunDetail, "status" | "steps">): Grounding {
  const validate: StepView | undefined = run.steps.find((s) => s.key === "validate");
  if (!validate || validate.status === "pending" || validate.status === "running") {
    return run.status === "done" || run.status === "error" ? { kind: "unavailable" } : { kind: "waiting" };
  }
  const detail = validate.detail;
  if (!detail || !("grounding" in detail)) return { kind: "unavailable" };
  if (detail.grounding === null) return { kind: "scanned" };
  if (!isRecord(detail.grounding) || !Array.isArray(detail.grounding.fields)) return { kind: "unavailable" };
  const fields = new Map<GroundedField, FieldGrounding["status"]>();
  for (const f of detail.grounding.fields) {
    if (!isRecord(f)) continue;
    const field = (GROUNDED_FIELDS as readonly string[]).includes(f.field as string) ? (f.field as GroundedField) : null;
    const status = f.status;
    if (field && (status === "grounded" || status === "missing" || status === "not_applicable")) fields.set(field, status);
  }
  return { kind: "ready", fields };
}

/** The validate stage's problems grouped by the extraction field they are about (display text only). */
function problemsByField(run: Pick<RunDetail, "steps">): Record<string, string[]> {
  const detail = run.steps.find((s) => s.key === "validate")?.detail;
  const raw = detail && isRecord(detail.field_problems) ? detail.field_problems : null;
  const out: Record<string, string[]> = {};
  if (!raw) return out;
  for (const [field, list] of Object.entries(raw).slice(0, 20)) {
    const texts = asStrings(list, 5)
      .map((t) => displayText(t, 300))
      .filter((t) => t !== "");
    if (texts.length > 0) out[field] = texts;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ cells */

function Dash({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">–</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The grounded cell of one field. A column cell is an icon with a screen-reader label (the header says what the
 * column is); on a phone, where the list has no header, `showLabel` writes the verdict out next to the icon.
 */
function GroundedCell({ field, grounding, showLabel = false }: { field: GroundedField | null; grounding: Grounding; showLabel?: boolean }) {
  if (field === null) return <Dash label="Not part of the grounding check" />;
  switch (grounding.kind) {
    case "waiting":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground" title="Checking against the document text">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          {showLabel ? <span className="text-xs font-medium">Checking</span> : <span className="sr-only">Being checked</span>}
        </span>
      );
    case "scanned":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground" title="Not checked (scanned)">
          <Minus aria-hidden="true" className="size-4" />
          {showLabel ? (
            <span className="text-xs font-medium">Not checked (scanned)</span>
          ) : (
            <span className="sr-only">Not checked (scanned): there is no text layer to compare the value with</span>
          )}
        </span>
      );
    case "unavailable":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground" title="Not checked">
          <Minus aria-hidden="true" className="size-4" />
          {showLabel ? <span className="text-xs font-medium">Not checked</span> : <span className="sr-only">Not checked</span>}
        </span>
      );
    case "ready":
      return <GroundedMark status={grounding.fields.get(field) ?? null} showLabel={showLabel} />;
  }
}

interface FieldRow {
  key: string;
  label: string;
  value: ReactNode;
  confidence?: number;
  grounded?: GroundedField;
  /** the key of the extraction field the validate stage files its problems under */
  problemKey: string;
}

function textOrNone(value: string | null, format?: (v: string) => ReactNode): ReactNode {
  const text = displayText(value, 300);
  return text === "" ? <Muted>Not found</Muted> : format ? format(text) : text;
}

/** An identifier is compared character by character, so it is set in the mono face. */
const identOf = (v: string): ReactNode => <Ident>{v}</Ident>;

function moneyOrNone(value: number | null, currency: string | null): ReactNode {
  const text = formatMoney(value, currency);
  return text === null ? <Muted>Not found</Muted> : <span className="tabular-nums">{text}</span>;
}

function buildRows(ex: InvoiceExtraction): FieldRow[] {
  const notes = displayText(ex.notes, 500);
  const rows: FieldRow[] = [
    { key: "document_type", label: "Document type", problemKey: "document_type", value: textOrNone(ex.document_type, (v) => wordFor("document_type", v) ?? v) },
    { key: "vendor_name", label: "Vendor", problemKey: "vendor_name", value: textOrNone(ex.vendor_name), confidence: ex.confidence.vendor_name },
    { key: "invoice_number", label: "Invoice number", problemKey: "invoice_number", value: textOrNone(ex.invoice_number, identOf), confidence: ex.confidence.invoice_number, grounded: "invoice_number" },
    { key: "invoice_date", label: "Invoice date", problemKey: "invoice_date", value: textOrNone(ex.invoice_date), confidence: ex.confidence.invoice_date },
    { key: "due_date", label: "Due date", problemKey: "due_date", value: textOrNone(ex.due_date) },
    { key: "po_reference", label: "PO reference", problemKey: "po_reference", value: textOrNone(ex.po_reference, identOf), confidence: ex.confidence.po_reference, grounded: "po_reference" },
    { key: "currency", label: "Currency", problemKey: "currency", value: textOrNone(ex.currency) },
    { key: "subtotal", label: "Subtotal", problemKey: "subtotal", value: moneyOrNone(ex.subtotal, ex.currency) },
    { key: "tax", label: "Tax", problemKey: "tax", value: moneyOrNone(ex.tax, ex.currency) },
    { key: "total", label: "Total", problemKey: "total", value: moneyOrNone(ex.total, ex.currency), confidence: ex.confidence.total, grounded: "total" },
    { key: "tax_inclusive", label: "Amounts include tax", problemKey: "tax_inclusive", value: ex.tax_inclusive ? "Yes" : "No" },
    { key: "bank_account", label: "Bank account", problemKey: "bank_account", value: textOrNone(ex.bank_account, identOf) },
  ];
  if (notes !== "") rows.push({ key: "notes", label: "Notes", problemKey: "notes", value: notes });
  const flagged = [
    ex.document_signals.multiple_documents ? "more than one document" : null,
    ex.document_signals.bank_change_notice ? "a bank-details change notice" : null,
    ex.document_signals.handwritten_changes ? "handwritten changes" : null,
  ].filter((s): s is string => s !== null);
  rows.push({ key: "document_signals", label: "Signals reported", problemKey: "document_signals", value: flagged.length === 0 ? "None reported" : flagged.join(", ") });
  rows.push({
    key: "suspicious_content",
    label: "Suspicious content",
    problemKey: "suspicious_content",
    value:
      ex.suspicious_content.length === 0
        ? "None reported"
        : `${ex.suspicious_content.length} reported, quoted in the warning above`,
  });
  return rows;
}

/** What the validate stage found wrong with one field, as text under it (full width, so a long sentence is not squeezed into the value column). */
function Problems({ texts, about }: { texts: readonly string[]; about: string }) {
  return (
    <>
      {texts.map((text, i) => (
        <span key={i} className="mt-1 flex items-start gap-1.5 text-xs text-reject">
          <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>
            <span className="font-medium">
              <span className="sr-only">{`${about}: `}</span>
              Problem:{" "}
            </span>
            {text}
          </span>
        </span>
      ))}
    </>
  );
}

const HEAD = "h-9 px-2.5 text-xs";

/**
 * A real table with four columns where there is room for it: from sm (640 px) while the card is the full page width,
 * not from lg to xl (1024 to 1279 px) where the two-column layout leaves the card about 375 px, and from xl up.
 */
function FieldsTable({ rows, grounding, problems }: { rows: FieldRow[]; grounding: Grounding; problems: Record<string, string[]> }) {
  return (
    <div className="hidden sm:block lg:hidden xl:block">
      <TableFrame label="Table of extracted fields">
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead scope="col" className={HEAD}>
              Field
            </TableHead>
            <TableHead scope="col" className={HEAD}>
              Value
            </TableHead>
            <TableHead scope="col" className={HEAD}>
              Confidence
            </TableHead>
            <TableHead scope="col" className={HEAD}>
              Grounded
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const issues = problems[row.problemKey] ?? [];
            return (
              <Fragment key={row.key}>
                <TableRow data-field={row.key} className={issues.length > 0 ? "border-b-0" : undefined}>
                  <TableHead scope="row" className="h-auto px-2.5 py-2 align-top text-sm font-normal whitespace-nowrap text-muted-foreground">
                    {row.label}
                  </TableHead>
                  <TableCell className="px-2.5 py-2 align-top whitespace-normal break-words [overflow-wrap:anywhere]">{row.value}</TableCell>
                  <TableCell className="px-2.5 py-2 align-top">
                    {row.confidence === undefined ? <Dash label="Not scored" /> : <ConfidenceChip value={row.confidence} size="sm" />}
                  </TableCell>
                  <TableCell className="px-2.5 py-2 align-top">
                    <GroundedCell field={row.grounded ?? null} grounding={grounding} />
                  </TableCell>
                </TableRow>
                {issues.length > 0 ? (
                  <TableRow data-field-problems={row.key} className="hover:bg-transparent">
                    <TableCell colSpan={4} className="px-2.5 pt-0 pb-2.5 whitespace-normal break-words [overflow-wrap:anywhere]">
                      <Problems texts={issues} about={row.label} />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </TableFrame>
    </div>
  );
}

/**
 * Where the table would not fit (below sm, a phone, and from lg to xl, the narrow right column): the same rows as a
 * list, one field per block, because a four-column table is wider than the card and its grounded column is the one
 * that must stay visible. The label sits on top, the value under it and the confidence chip and the grounded verdict
 * (written out, no column header here) on the right.
 */
function FieldCards({ rows, grounding, problems }: { rows: FieldRow[]; grounding: Grounding; problems: Record<string, string[]> }) {
  return (
    <ul aria-label="Extracted fields" className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-foreground/10 sm:hidden lg:block xl:hidden">
      {rows.map((row) => (
        <li key={row.key} data-field={row.key} className="space-y-1 px-3 py-2.5">
          <p className="text-xs text-muted-foreground">{row.label}</p>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 text-sm break-words [overflow-wrap:anywhere]">{row.value}</div>
            {row.confidence !== undefined || row.grounded ? (
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {row.confidence === undefined ? null : <ConfidenceChip value={row.confidence} size="sm" />}
                {row.grounded ? <GroundedCell field={row.grounded} grounding={grounding} showLabel /> : null}
              </div>
            ) : null}
          </div>
          <div className="text-sm break-words [overflow-wrap:anywhere]">
            <Problems texts={problems[row.problemKey] ?? []} about={row.label} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function LineItems({ ex }: { ex: InvoiceExtraction }) {
  const lines = ex.line_items.slice(0, 50);
  return (
    <section aria-labelledby="line-items-heading" className="space-y-2">
      <h3 id="line-items-heading" className="text-sm font-semibold">
        {`Line items (${ex.line_items.length})`}
      </h3>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No line items were read from the document.</p>
      ) : (
        <>
          <div className="hidden sm:block lg:hidden xl:block">
            <TableFrame label="Line items">
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead scope="col" className={HEAD}>
                    Description
                  </TableHead>
                  <TableHead scope="col" className={`${HEAD} text-right`}>
                    Qty
                  </TableHead>
                  <TableHead scope="col" className={`${HEAD} text-right`}>
                    Unit price
                  </TableHead>
                  <TableHead scope="col" className={`${HEAD} text-right`}>
                    Amount
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((li, i) => (
                  <TableRow key={i}>
                    <TableCell className="px-2.5 py-2 align-top whitespace-normal break-words [overflow-wrap:anywhere]">
                      {displayText(li.description, 200) || <Muted>(no description)</Muted>}
                    </TableCell>
                    <TableCell className="px-2.5 py-2 text-right align-top tabular-nums">{li.quantity === null ? <Dash label="No quantity" /> : formatCount(li.quantity)}</TableCell>
                    <TableCell className="px-2.5 py-2 text-right align-top tabular-nums">
                      {formatMoney(li.unit_price, ex.currency, { precise: true }) ?? <Dash label="No unit price" />}
                    </TableCell>
                    <TableCell className="px-2.5 py-2 text-right align-top tabular-nums">{formatMoney(li.amount, ex.currency) ?? <Dash label="No amount" />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableFrame>
          </div>
          <ul aria-label="Line items" className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-foreground/10 sm:hidden lg:block xl:hidden">
            {lines.map((li, i) => {
              const unit = formatMoney(li.unit_price, ex.currency, { precise: true });
              const detail =
                li.quantity !== null && unit !== null ? `${formatCount(li.quantity)} × ${unit}` : li.quantity !== null ? `Qty ${formatCount(li.quantity)}` : unit !== null ? `Unit price ${unit}` : "";
              return (
                <li key={i} className="space-y-1 px-3 py-2.5">
                  <p className="text-sm break-words [overflow-wrap:anywhere]">{displayText(li.description, 200) || <Muted>(no description)</Muted>}</p>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-muted-foreground tabular-nums">{detail}</span>
                    <span className="font-medium tabular-nums">{formatMoney(li.amount, ex.currency) ?? "–"}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ the card */

export interface ExtractedFieldsProps {
  run: RunDetail;
}

/**
 * What the model read from the PDF: each field with the model's own confidence and whether the value was found in
 * the document text (the validate stage's grounding), then the line items. The fields appear as soon as the
 * Extract stage has stored them, while later stages are still running; the grounded column fills in when the
 * validate stage finishes. A scanned document has no text layer, so its grounded cells are dashes with a tooltip.
 * A table from the sm breakpoint up, a list on a phone (see FieldCards).
 */
export function ExtractedFields({ run }: ExtractedFieldsProps) {
  const ex = run.extraction;
  const extract = run.steps.find((s) => s.key === "extract");
  const settled = run.status === "done" || run.status === "error";
  const waiting = !settled && (!extract || extract.status === "pending" || extract.status === "running");
  const grounding = groundingOf(run);
  const rows = ex ? buildRows(ex) : [];
  const problems = problemsByField(run);
  const reason = displayText(extract?.reason, 300);

  return (
    <section aria-labelledby="fields-heading" className="space-y-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
      <div className="space-y-1">
        <h2 id="fields-heading" className="text-base font-semibold">
          Extracted fields
        </h2>
        <p className="text-sm text-muted-foreground">
          What the model read from the PDF. Confidence is the model&apos;s own score; Grounded means the value was found in the document text.
        </p>
      </div>
      {ex ? (
        <>
          <FieldsTable rows={rows} grounding={grounding} problems={problems} />
          <FieldCards rows={rows} grounding={grounding} problems={problems} />
          {grounding.kind === "scanned" ? (
            <p className="text-sm text-muted-foreground">This is a scanned document with no text layer, so the values could not be checked against the document text.</p>
          ) : null}
          <p className="text-xs text-muted-foreground">Confidence: green from 0.90, amber from 0.75 to below 0.90, red below 0.75.</p>
          <LineItems ex={ex} />
        </>
      ) : waiting ? (
        <div className="space-y-3">
          <TextSkeleton lines={4} />
          <p role="status" className="text-sm text-muted-foreground">
            The fields appear as soon as the Extract stage has read the document.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{reason ? `No fields were extracted. ${reason}` : "No fields were extracted."}</p>
      )}
    </section>
  );
}
