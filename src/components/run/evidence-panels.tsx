"use client";

import Link from "next/link";
import { Component, useId, useState, type ReactNode } from "react";
import { ArrowRight, Check, CircleX, Copy, Info, Minus, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { DecisionBadge } from "@/components/shared/decision-badge";
import { EvidenceQuote } from "@/components/shared/security-banner";
import { TableFrame } from "@/components/shared/table-frame";
import { INK_TONE, SOFT_TONE, type Tone } from "@/components/shared/tones";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DECISIONS, type Decision, type StepView } from "@/lib/types";
import { wordFor } from "./evidence-model";
import { KeyValueList } from "./key-values";
import {
  asBool,
  asNumber,
  asString,
  asStrings,
  displayText,
  escapeInvisible,
  formatCost,
  formatDuration,
  formatMoney,
  formatPercent,
  isRecord,
  isUuid,
} from "./run-format";

/* ------------------------------------------------------------------------------------------------ small pieces */

/** A titled group inside an evidence panel (h3: the page h1, the card h2s and the stage rows come before it). */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** A tinted box with an icon and a title: the one thing a stage wants you to notice. */
function Callout({ tone, icon, title, children }: { tone: Tone; icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className={cn("flex gap-3 rounded-lg border p-3 text-sm", SOFT_TONE[tone])}>
      <span aria-hidden="true" className="mt-0.5 shrink-0 [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-semibold break-words">{title}</p>
        {children ? <div className="space-y-2 text-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

/** A quote of text some other system produced (not a security finding): plain, with a caption. Only ever a string. */
function PlainQuote({ label, children }: { label: string; children: string }) {
  return (
    <figure className="min-w-0 space-y-1">
      <figcaption className="text-xs font-medium text-muted-foreground">{label}</figcaption>
      <blockquote className="rounded-md border border-l-4 border-border border-l-muted-foreground bg-card px-3 py-2 text-sm leading-relaxed break-words [overflow-wrap:anywhere] text-foreground">
        {children}
      </blockquote>
    </figure>
  );
}

function IconList({ tone, items }: { tone: "reject" | "hold"; items: readonly string[] }) {
  const Icon = tone === "reject" ? CircleX : TriangleAlert;
  return (
    <ul className="space-y-1.5">
      {items.map((text, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", INK_TONE[tone])} />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A link to another run, built only from an id that is a UUID; anything else is plain text. */
function RunLink({ id, children }: { id: unknown; children: ReactNode }) {
  if (!isUuid(id)) return <span>{children}</span>;
  return (
    <Link
      href={`/runs/${encodeURIComponent(id)}`}
      prefetch={false}
      className="inline-flex min-h-6 items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80"
    >
      {children}
      <ArrowRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

/** Column headers of the evidence tables may wrap (a long one would otherwise decide the width of its column on a phone). */
const HEAD = "h-9 px-3 py-1.5 text-xs whitespace-normal";
const CELL = "px-3 py-2 align-top whitespace-normal break-words [overflow-wrap:anywhere]";

function strings(value: unknown, cap: number, max = 600): string[] {
  return asStrings(value, cap)
    .map((s) => displayText(s, max))
    .filter((s) => s !== "");
}

/** What a stage's curated view shows, which top-level keys it covers, and which others are noise while empty. */
interface Curated {
  node: ReactNode;
  used?: ReadonlySet<string>;
  hideEmpty?: ReadonlySet<string>;
}

/* ------------------------------------------------------------------------------------------------ stage 1: ingest */

function ingestCurated(detail: Record<string, unknown>): Curated {
  if (!isUuid(detail.run_id)) return { node: null };
  return {
    node: (
      <Callout tone="reject" icon={<Copy />} title="This exact file was already processed">
        <p>The same bytes were uploaded before, so the file is rejected before anything else runs.</p>
        <RunLink id={detail.run_id}>Open the earlier run</RunLink>
      </Callout>
    ),
    used: new Set(["run_id"]),
  };
}

/* ------------------------------------------------------------------------------------------------ stage 2: screen */

function screenCurated(detail: Record<string, unknown>): Curated {
  const hits = strings(detail.injectionHits, 20);
  const hidden = strings(detail.hiddenText, 10);
  return {
    node: (
      <>
        {hits.length > 0 ? (
          <Block title={`Instruction-like text found by the text scan (${hits.length})`}>
            {hits.map((hit, i) => (
              <EvidenceQuote key={i}>{hit}</EvidenceQuote>
            ))}
          </Block>
        ) : null}
        {hidden.length > 0 ? (
          <Block title={`Hidden text found: tiny, not visible when the page is viewed (${hidden.length})`}>
            {hidden.map((run, i) => (
              <EvidenceQuote key={i}>{run}</EvidenceQuote>
            ))}
          </Block>
        ) : null}
        {hits.length === 0 && hidden.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {detail.isImageOnly === true
              ? "This is a scanned image with no text layer, so there was nothing to scan for hidden or instruction-like text. The model's own report in the Extract stage is the check that remains."
              : "No instruction-like phrases and no hidden text were found in the text layer."}
          </p>
        ) : null}
      </>
    ),
    used: new Set(["injectionHits", "hiddenText"]),
  };
}

/* ------------------------------------------------------------------------------------------------ stage 3: extract */

function AttemptsTable({ attempts }: { attempts: unknown[] }) {
  const rows = attempts.filter(isRecord).slice(0, 10);
  if (rows.length === 0) return null;
  // The tokens column only earns its width when some attempt reports tokens (the mock reports none).
  const showTokens = rows.some((a) => asNumber(a.promptTokens) !== null || asNumber(a.completionTokens) !== null);
  return (
    <Block title="Attempts">
      <TableFrame label="Model attempts">
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead scope="col" className={HEAD}>
              Model
            </TableHead>
            <TableHead scope="col" className={HEAD}>
              Result
            </TableHead>
            <TableHead scope="col" className={cn(HEAD, "text-right")}>
              Time
            </TableHead>
            <TableHead scope="col" className={cn(HEAD, "text-right")}>
              Cost
            </TableHead>
            {showTokens ? (
              <TableHead scope="col" className={cn(HEAD, "text-right")}>
                Tokens in / out
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((a, i) => {
            const model = displayText(a.model, 80) || "unknown";
            const served = displayText(a.servedBy, 80);
            const failure = asString(a.failure);
            const ok = asBool(a.ok) === true;
            const message = displayText(a.message, 200);
            const tokensIn = asNumber(a.promptTokens);
            const tokensOut = asNumber(a.completionTokens);
            return (
              <TableRow key={i}>
                <TableCell className={CELL}>
                  {model}
                  {served && served !== model ? <span className="block text-xs text-muted-foreground">{`served by ${served}`}</span> : null}
                </TableCell>
                <TableCell className={CELL}>
                  {ok ? (
                    <span className="font-medium text-approve">Succeeded</span>
                  ) : (
                    <span className="font-medium text-reject">{failure ? (wordFor("failure", failure) ?? displayText(failure, 40)) : "Failed"}</span>
                  )}
                  {message ? <span className="block text-xs text-muted-foreground">{message}</span> : null}
                </TableCell>
                <TableCell className={cn(CELL, "text-right tabular-nums")}>{formatDuration(asNumber(a.latencyMs)) ?? "–"}</TableCell>
                <TableCell className={cn(CELL, "text-right tabular-nums")}>{formatCost(asNumber(a.costUsd))}</TableCell>
                {showTokens ? (
                  <TableCell className={cn(CELL, "text-right tabular-nums")}>
                    {tokensIn === null && tokensOut === null ? "–" : `${tokensIn ?? "–"} / ${tokensOut ?? "–"}`}
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </TableFrame>
    </Block>
  );
}

function extractCurated(detail: Record<string, unknown>, promptVersion: string | null): Curated {
  const suspicious = strings(detail.suspicious_content, 20);
  const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
  const mock = detail.model === "mock";
  const prompt = displayText(promptVersion, 60);
  return {
    node: (
      <>
        {prompt ? (
          <dl className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
            <dt className="text-sm text-muted-foreground">Prompt version</dt>
            <dd className="text-sm">{prompt}</dd>
          </dl>
        ) : null}
        {mock ? (
          <p className="text-sm text-muted-foreground">
            The model is &quot;mock&quot;: an offline stand-in that returns the expected values for the sample invoices. No real model was called and the model time is simulated.
          </p>
        ) : null}
        <AttemptsTable attempts={attempts} />
        {suspicious.length > 0 ? (
          <Block title={`Reported by the model as suspicious (${suspicious.length})`}>
            {suspicious.map((text, i) => (
              <EvidenceQuote key={i}>{text}</EvidenceQuote>
            ))}
          </Block>
        ) : null}
      </>
    ),
    used: new Set(["attempts", "suspicious_content"]),
  };
}

/* ------------------------------------------------------------------------------------------------ stage 4: validate */

function GroundingResult({ status }: { status: string }) {
  const word = wordFor("status", status) ?? displayText(status, 40);
  if (status === "grounded") {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-approve">
        <Check aria-hidden="true" className="size-4 shrink-0" />
        {word}
      </span>
    );
  }
  if (status === "missing") {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-reject">
        <X aria-hidden="true" className="size-4 shrink-0" />
        {word}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Minus aria-hidden="true" className="size-4 shrink-0" />
      {word}
    </span>
  );
}

function groundingValue(value: unknown): string {
  if (typeof value === "number") return formatMoney(value, null) ?? String(value);
  const text = displayText(value, 120);
  return text === "" ? "–" : text;
}

/** Derived numbers that are null when the document had nothing to derive them from: noise, not evidence. */
const VALIDATE_QUIET = new Set(["line_sum", "expected_total", "pretax_amount"]);

function validateCurated(detail: Record<string, unknown>): Curated {
  const problems = strings(detail.problems, 30);
  const warnings = strings(detail.warnings, 30);
  const hasGrounding = "grounding" in detail;
  const grounding = isRecord(detail.grounding) ? detail.grounding : null;
  const fields = grounding && Array.isArray(grounding.fields) ? grounding.fields.filter(isRecord).slice(0, 10) : [];
  // Every miss is also one of the problems; only a miss the problem list does not repeat is listed on its own.
  const extraMisses = grounding ? strings(grounding.misses, 10).filter((m) => !problems.includes(m)) : [];
  // A statement or a blank extraction has nothing to look up: say so once instead of drawing a table of dashes.
  const nothingToCheck = fields.length > 0 && fields.every((f) => f.status === "not_applicable");
  return {
    node: (
      <>
        {problems.length > 0 ? (
          <Block title={`Problems found (${problems.length})`}>
            <IconList tone="reject" items={problems} />
          </Block>
        ) : null}
        {warnings.length > 0 ? (
          <Block title={`Warnings (${warnings.length})`}>
            <IconList tone="hold" items={warnings} />
          </Block>
        ) : null}
        {problems.length === 0 && warnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No problems and no warnings.</p>
        ) : null}
        {hasGrounding ? (
          <Block title="Grounding: do the key values appear in the document text?">
            {grounding === null ? (
              <p className="text-sm text-muted-foreground">Not checked: this is a scanned document, so there is no text layer to compare the values with.</p>
            ) : nothingToCheck ? (
              <p className="text-sm text-muted-foreground">Nothing to check: the model returned no invoice number, PO reference or total to look for in the document text.</p>
            ) : fields.length > 0 ? (
              <TableFrame label="Grounding of the key values">
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead scope="col" className={HEAD}>
                      Field
                    </TableHead>
                    <TableHead scope="col" className={HEAD}>
                      Value the model returned
                    </TableHead>
                    <TableHead scope="col" className={HEAD}>
                      Result
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fields.map((f, i) => {
                    const field = asString(f.field) ?? "";
                    const status = asString(f.status) ?? "";
                    const matched = displayText(f.matchedToken, 100);
                    return (
                      <TableRow key={i}>
                        <TableCell className={CELL}>{wordFor("field", field) ?? (displayText(field, 40) || "–")}</TableCell>
                        <TableCell className={cn(CELL, "tabular-nums")}>{groundingValue(f.value)}</TableCell>
                        <TableCell className={CELL}>
                          <GroundingResult status={status} />
                          {matched ? <span className="block text-xs text-muted-foreground">{`found as ${matched}`}</span> : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </TableFrame>
            ) : null}
            {extraMisses.length > 0 ? <IconList tone="reject" items={extraMisses} /> : null}
          </Block>
        ) : null}
      </>
    ),
    used: new Set(["problems", "warnings", "grounding", "field_problems", "problem_kinds"]),
    hideEmpty: VALIDATE_QUIET,
  };
}

/* ------------------------------------------------------------------------------------------------ stage 7: po match */

const PO_QUIET = new Set([
  "candidates",
  "confidence",
  "reasoning",
  "printed_po",
  "problem",
  "amount",
  "found_po",
  "suggested_po",
  "suggestion_failure",
]);

function poMatchCurated(detail: Record<string, unknown>): Curated {
  const po = displayText(detail.po_number, 40);
  if (detail.inferred !== true || po === "") return { node: null, hideEmpty: PO_QUIET };
  const confidence = asNumber(detail.confidence);
  const candidates = strings(detail.candidates, 20, 40);
  const reasoning = displayText(detail.reasoning, 600);
  const from =
    candidates.length > 1 ? ` out of ${candidates.length} candidate POs (${candidates.join(", ")})` : candidates.length === 1 ? " (the only candidate)" : "";
  return {
    node: (
      <Callout tone="hold" icon={<Info />} title="The AI suggests, a person confirms">
        <p>
          {`The invoice prints no PO number. The agent inferred ${po}${confidence !== null ? ` with confidence ${confidence.toFixed(2)}` : ""}${from}.`}
        </p>
        <p>An inferred PO always needs an AP lead to confirm it: the run is held, never approved on a guess.</p>
        {reasoning ? <PlainQuote label="Reasoning of the matcher">{reasoning}</PlainQuote> : null}
      </Callout>
    ),
    used: new Set(["po_number", "inferred", "candidates", "confidence", "reasoning", "problem"]),
    hideEmpty: PO_QUIET,
  };
}

/* ------------------------------------------------------------------------------------------------ stage 8: amounts */

/** The real minus sign (U+2212), built from its code point so the source holds no escape or odd character. */
const MINUS_SIGN = String.fromCodePoint(0x2212);

interface LedgerRow {
  label: string;
  value: string;
  tone?: Tone;
  strong?: boolean;
  note?: string;
}

function Ledger({ rows }: { rows: LedgerRow[] }) {
  return (
    <dl className="overflow-hidden rounded-lg border border-border bg-card text-sm">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn(
            "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2",
            i > 0 && "border-t border-border",
            row.strong && "bg-muted/60",
            row.tone && SOFT_TONE[row.tone],
          )}
        >
          <dt className={cn("min-w-0 flex-1 break-words [overflow-wrap:anywhere]", row.tone ? "text-foreground" : "text-muted-foreground", row.strong && "font-medium text-foreground")}>
            {row.label}
            {row.note ? <span className="block text-xs text-muted-foreground">{row.note}</span> : null}
          </dt>
          <dd className={cn("shrink-0 text-right font-medium tabular-nums", row.tone && INK_TONE[row.tone])}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function priceResult(over: number | null, within: boolean | null): { text: string; tone: "approve" | "hold" | "reject" } {
  if (over === null || over <= 0) return { text: "At or below the PO price", tone: "approve" };
  return within ? { text: "Above the PO price, within tolerance", tone: "hold" } : { text: "Above the PO price, beyond tolerance", tone: "reject" };
}

function PriceTable({ lines }: { lines: Record<string, unknown>[] }) {
  return (
    <TableFrame label="Unit prices against the PO">
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50">
          <TableHead scope="col" className={HEAD}>
            Invoice line
          </TableHead>
          <TableHead scope="col" className={cn(HEAD, "text-right")}>
            Invoice price
          </TableHead>
          <TableHead scope="col" className={cn(HEAD, "text-right")}>
            PO price
          </TableHead>
          <TableHead scope="col" className={cn(HEAD, "text-right")}>
            Difference
          </TableHead>
          <TableHead scope="col" className={HEAD}>
            Result
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line, i) => {
          const overBy = asNumber(line.over_by);
          const overPct = asNumber(line.over_pct);
          const result = priceResult(overBy, asBool(line.within_tolerance));
          const diff = overPct === null ? (overBy !== null && overBy > 0 ? "n/a" : "–") : `${overPct > 0 ? "+" : ""}${formatPercent(overPct)}`;
          const Icon = result.tone === "approve" ? Check : result.tone === "hold" ? TriangleAlert : X;
          const description = displayText(line.description, 80) || "–";
          const poDescription = displayText(line.po_description, 80);
          // Say which PO line it was paired with only when the wording is not the same.
          const differs = poDescription !== "" && poDescription.toLowerCase() !== description.toLowerCase();
          return (
            <TableRow key={i}>
              <TableCell className={CELL}>
                {description}
                {differs ? <span className="block text-xs text-muted-foreground">{`PO line: ${poDescription}`}</span> : null}
              </TableCell>
              <TableCell className={cn(CELL, "text-right tabular-nums")}>{formatMoney(asNumber(line.invoice_unit_price), null, { precise: true }) ?? "–"}</TableCell>
              <TableCell className={cn(CELL, "text-right tabular-nums")}>{formatMoney(asNumber(line.po_unit_price), null, { precise: true }) ?? "–"}</TableCell>
              <TableCell className={cn(CELL, "text-right tabular-nums")}>{diff}</TableCell>
              <TableCell className={CELL}>
                <span className={cn("inline-flex items-start gap-1.5", INK_TONE[result.tone])}>
                  <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{result.text}</span>
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </TableFrame>
  );
}

/** "34", "2.5", "200,000": an invoice quantity as plain text. */
function quantityText(n: number | null): string {
  return n === null ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** What the invoice bills against each PO line, in units and value, next to what the line orders (fix round DEC-1). */
function LineTotalsTable({ totals }: { totals: Record<string, unknown>[] }) {
  return (
    <TableFrame label="Billed against each PO line">
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50">
          <TableHead scope="col" className={HEAD}>
            PO line
          </TableHead>
          <TableHead scope="col" className={cn(HEAD, "text-right")}>
            Ordered
          </TableHead>
          <TableHead scope="col" className={cn(HEAD, "text-right")}>
            Billed
          </TableHead>
          <TableHead scope="col" className={HEAD}>
            Result
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {totals.map((line, i) => {
          const within = asBool(line.within_tolerance) !== false;
          const billedQuantity = asNumber(line.billed_quantity);
          const lines = asNumber(line.invoice_lines);
          const tone = within ? "approve" : "reject";
          const Icon = within ? Check : X;
          const why = asBool(line.quantity_over) === true ? "More units than ordered" : "Billed above the line's value";
          return (
            <TableRow key={i}>
              <TableCell className={CELL}>
                {displayText(line.po_description, 80) || "–"}
                {lines !== null && lines > 1 ? <span className="block text-xs text-muted-foreground">{`${lines} invoice lines`}</span> : null}
              </TableCell>
              <TableCell className={cn(CELL, "text-right tabular-nums")}>
                {`${quantityText(asNumber(line.po_quantity))} for ${formatMoney(asNumber(line.po_amount), null) ?? "–"}`}
              </TableCell>
              <TableCell className={cn(CELL, "text-right tabular-nums")}>
                {`${billedQuantity === null ? "no quantity" : quantityText(billedQuantity)} for ${formatMoney(asNumber(line.billed_amount), null) ?? "–"}`}
              </TableCell>
              <TableCell className={CELL}>
                <span className={cn("inline-flex items-start gap-1.5", INK_TONE[tone])}>
                  <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{within ? "Within what the PO line orders" : why}</span>
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </TableFrame>
  );
}

const AMOUNTS_USED = new Set([
  "line_totals",
  "line_totals_within_tolerance",
  "po_number",
  "po_subtotal",
  "already_approved",
  "approved_invoices",
  "approved_invoice_count",
  "remaining",
  "invoice_subtotal",
  "amount_source",
  "over_by",
  "over_pct",
  "tolerance_pct",
  "within_tolerance",
  "price_within_tolerance",
  "unmatched_within_tolerance",
  "lines",
  "unmatched_lines",
  "unmatched_total",
  "tax_inclusive",
]);

function amountsCurated(detail: Record<string, unknown>): Curated {
  const po = displayText(detail.po_number, 40) || "The PO";
  const poSubtotal = asNumber(detail.po_subtotal);
  const approved = asNumber(detail.already_approved);
  const remaining = asNumber(detail.remaining);
  const amount = asNumber(detail.invoice_subtotal);
  const overBy = asNumber(detail.over_by);
  const overPct = asNumber(detail.over_pct);
  const tolerance = asNumber(detail.tolerance_pct);
  const within = asBool(detail.within_tolerance);
  const invoices = strings(detail.approved_invoices, 20, 40);
  const invoiceCount = asNumber(detail.approved_invoice_count) ?? invoices.length;
  const source = asString(detail.amount_source);
  const lines = (Array.isArray(detail.lines) ? detail.lines : []).filter(isRecord).slice(0, 25);
  const unmatched = (Array.isArray(detail.unmatched_lines) ? detail.unmatched_lines : []).filter(isRecord).slice(0, 25);
  const unmatchedTotal = asNumber(detail.unmatched_total);
  const lineTotals = (Array.isArray(detail.line_totals) ? detail.line_totals : []).filter(isRecord).slice(0, 25);
  const toleranceText = tolerance === null ? "the" : formatPercent(tolerance);

  const money = (n: number) => formatMoney(n, null) ?? String(n);
  const approvedAmount = approved ?? (poSubtotal !== null && remaining !== null ? poSubtotal - remaining : 0);
  let ledger: ReactNode = null;
  if (poSubtotal !== null && remaining !== null && amount !== null) {
    const approvedLabel =
      invoices.length > 0
        ? `Already approved (${invoices.join(", ")}${invoiceCount > invoices.length ? ` and ${invoiceCount - invoices.length} more` : ""})`
        : "Already approved";
    const rows: LedgerRow[] = [
      { label: `${po} total`, value: money(poSubtotal) },
      { label: approvedLabel, value: approvedAmount > 0 ? MINUS_SIGN + money(approvedAmount) : money(approvedAmount) },
      { label: "Remaining on the PO", value: money(remaining), strong: true },
      { label: source !== null && source !== "subtotal" ? "This invoice (total, no subtotal printed)" : "This invoice (subtotal)", value: money(amount) },
    ];
    if (overBy !== null && overBy > 0) {
      const share =
        overPct !== null
          ? `${formatPercent(overPct)} of the remaining balance`
          : remaining <= 0
            ? "nothing is left on the PO, so no tolerance applies"
            : null;
      rows.push({
        label: within ? `Over the remaining balance, within the ${toleranceText} tolerance` : `Over the remaining balance, beyond the ${toleranceText} tolerance`,
        value: money(overBy),
        tone: within ? "hold" : "reject",
        note: share ?? undefined,
      });
    } else {
      rows.push({
        label: "Left on the PO after this invoice",
        value: money(Math.round((remaining - amount) * 100) / 100),
        tone: "approve",
      });
    }
    ledger = (
      <Block title="PO balance maths">
        <Ledger rows={rows} />
      </Block>
    );
  }

  return {
    node: (
      <>
        {ledger}
        {lines.length > 0 ? (
          <Block title="Unit prices against the PO lines">
            <PriceTable lines={lines} />
          </Block>
        ) : null}
        {lineTotals.length > 0 ? (
          <Block title="Units and amounts against each PO line">
            <LineTotalsTable totals={lineTotals} />
          </Block>
        ) : null}
        {unmatched.length > 0 ? (
          <Block title="Billed lines that match no PO line">
            <TableFrame label="Lines that are not on the PO">
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead scope="col" className={HEAD}>
                    Description
                  </TableHead>
                  <TableHead scope="col" className={cn(HEAD, "text-right")}>
                    Amount
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unmatched.map((u, i) => (
                  <TableRow key={i}>
                    <TableCell className={CELL}>{displayText(u.description, 80) || "–"}</TableCell>
                    <TableCell className={cn(CELL, "text-right tabular-nums")}>{formatMoney(asNumber(u.amount), null) ?? "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableFrame>
            {unmatchedTotal !== null ? <p className="text-xs text-muted-foreground">{`${money(unmatchedTotal)} is billed on lines the PO does not list.`}</p> : null}
          </Block>
        ) : null}
        {detail.tax_inclusive === true ? (
          <p className="text-sm text-muted-foreground">The invoice amounts include tax, but the PO is pre-tax, so the comparison is conservative.</p>
        ) : null}
        {ledger === null && lines.length === 0 && unmatched.length === 0 && lineTotals.length === 0 ? (
          <p className="text-sm text-muted-foreground">There was no PO balance to check this invoice against.</p>
        ) : null}
      </>
    ),
    used: AMOUNTS_USED,
  };
}

/* ------------------------------------------------------------------------------------------------ stage 9: duplicate */

function duplicateCurated(detail: Record<string, unknown>): Curated {
  const used = new Set(["match", "recurring", "original_decision", "days_apart", "window_days", "lookalike"]);
  const match = isRecord(detail.match) ? detail.match : null;
  const recurring = isRecord(detail.recurring) ? detail.recurring : null;
  if (match) {
    const hard = match.kind === "hard";
    const lookalike = !hard && detail.lookalike === true;
    const number = displayText(match.invoice_number, 60) || "an earlier invoice";
    const date = displayText(match.invoice_date, 20);
    const daysApart = asNumber(detail.days_apart);
    const windowDays = asNumber(detail.window_days);
    const earlier = asString(detail.original_decision);
    const apart = daysApart !== null ? ` The two are ${daysApart} ${daysApart === 1 ? "day" : "days"} apart.` : "";
    return {
      node: (
        <Callout tone={hard ? "reject" : "hold"} icon={<Copy />} title={hard ? `Duplicate of ${number}` : `Possible duplicate of ${number}`}>
          <p>
            {hard
              ? "The invoice number is the same as an earlier invoice from this vendor once formatting is ignored (a hyphen, a space, upper or lower case)."
              : lookalike
                ? `The invoice number differs from an earlier invoice of this vendor only by look-alike characters (the letter O for zero, I or L for one) or by leading zeros, whatever the amount and the date.${apart}`
                : `Same vendor and the same amount as the earlier invoice${daysApart !== null ? `, ${daysApart} ${daysApart === 1 ? "day" : "days"} apart` : ", close in time"} (the window is ${windowDays ?? 7} days), but a different invoice number.`}
          </p>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Earlier invoice</dt>
            <dd className="break-words">{number}</dd>
            {date ? (
              <>
                <dt className="text-muted-foreground">Dated</dt>
                <dd>{date}</dd>
              </>
            ) : null}
            {earlier && (DECISIONS as readonly string[]).includes(earlier) ? (
              <>
                <dt className="text-muted-foreground">Decision on it</dt>
                <dd>
                  <DecisionBadge decision={earlier as Decision} size="sm" />
                </dd>
              </>
            ) : null}
          </dl>
          <RunLink id={match.run_id}>Open the earlier record</RunLink>
        </Callout>
      ),
      used,
    };
  }
  if (recurring) {
    const number = displayText(recurring.invoice_number, 60) || "an earlier invoice";
    const date = displayText(recurring.invoice_date, 20);
    const days = asNumber(recurring.days_apart);
    return {
      node: (
        <Callout tone="info" icon={<Info />} title="Recurring charge, not a duplicate">
          <p>
            {`Same vendor and amount as ${number}${date ? ` (dated ${date})` : ""}${days !== null ? `, ${days} days apart` : ""}, but a different invoice number and outside the duplicate window. A repeating monthly charge is expected.`}
          </p>
        </Callout>
      ),
      used,
    };
  }
  return {
    node: <p className="text-sm text-muted-foreground">No earlier invoice from this vendor has the same invoice number or the same amount.</p>,
    used,
  };
}

/* ------------------------------------------------------------------------------------------------ raw data */

/** The stored detail as indented JSON text, for auditors: every hidden character shown as an escape, never drawn. */
function RawData({ detail, label }: { detail: Record<string, unknown>; label: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  let json = "";
  if (open) {
    try {
      json = escapeInvisible(JSON.stringify(detail, null, 2) ?? "");
    } catch {
      json = "(this data cannot be shown)";
    }
    if (json.length > 20_000) json = `${json.slice(0, 20_000)}\n... (cut)`;
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-6 items-center rounded-sm text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {open ? "Hide raw data" : "Show raw data (JSON)"}
      </button>
      {open ? (
        <pre
          id={id}
          tabIndex={0}
          role="region"
          aria-label={`Raw data of ${label}`}
          className="max-h-80 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
        >
          {json}
        </pre>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ the panel */

function curatedFor(step: StepView, detail: Record<string, unknown>, promptVersion: string | null): Curated {
  switch (step.key) {
    case "ingest":
      return ingestCurated(detail);
    case "screen":
      return screenCurated(detail);
    case "extract":
      return extractCurated(detail, promptVersion);
    case "validate":
      return validateCurated(detail);
    case "po_match":
      return poMatchCurated(detail);
    case "amounts":
      return amountsCurated(detail);
    case "duplicate":
      return duplicateCurated(detail);
    default:
      return { node: null };
  }
}

export interface EvidencePanelProps {
  step: StepView;
  /** runs.prompt_version, shown with the extract stage's evidence. */
  promptVersion: string | null;
}

/**
 * The evidence behind one stage, shown when its row is expanded: the stage's full reason, a curated view for
 * the stages whose evidence is worth reading as a picture (the PO balance maths, the matched earlier invoice, the
 * quoted hits, the grounding table, the inferred-PO reasoning), then every other key as a labelled row. Anything
 * a stage adds later still appears through the generic rows. All of it is plain React text.
 */
export function EvidencePanel({ step, promptVersion }: EvidencePanelProps) {
  if (step.status === "pending") return <p className="text-sm text-muted-foreground">This stage has not started yet.</p>;
  if (step.status === "running") {
    return <p className="text-sm text-muted-foreground">This stage is running. Its evidence appears here as soon as it finishes.</p>;
  }
  const detail = step.detail;
  if (!detail || Object.keys(detail).length === 0) {
    return <p className="text-sm text-muted-foreground">No further evidence was recorded for this stage. Its reason is the line above.</p>;
  }
  const curated = curatedFor(step, detail, promptVersion);
  return (
    <div className="space-y-4">
      {curated.node}
      <KeyValueList stage={step.key} data={detail} omit={curated.used} hideEmpty={curated.hideEmpty} />
      <RawData detail={detail} label={displayText(step.label, 60) || step.key} />
    </div>
  );
}

/**
 * Catches a failure while one stage's evidence is drawn (a stored value of a shape nobody expected), so that
 * stage shows a notice and the rest of the page keeps working. Key it by what it shows: a later poll then starts clean.
 */
export class EvidenceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <p className="text-sm text-reject">The evidence of this stage could not be shown. The reason above is still correct.</p>;
    }
    return this.props.children;
  }
}
