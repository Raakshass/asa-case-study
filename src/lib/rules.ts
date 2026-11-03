/**
 * Every business check, decide() and nextAction() (IMPLEMENTATION_PLAN.md section 7). PURE: no fs, db,
 * network or clock. Inputs are the extraction, its normalization, a master-data Snapshot (master.ts) and
 * an explicit `now`; suggestPO is injected (SuggestPoFn) so scripts/check.ts runs with no LLM.
 * Every check returns a StepResult (types.ts) whose reason is plain sentences.
 *
 * OWNER: Phase 3. Reason phrases that scripts/check.ts asserts (via truth _meta) are listed in
 * docs/CONTRACTS.md 3.3. Rules of this file:
 * - Identifiers are compared with format.ts normId, money is printed with formatUsd, amounts are rounded
 *   with round2 before they are compared (no float drift).
 * - Everything derived from the invoice is untrusted: it is only ever quoted (clip(): one short plain
 *   line), never interpreted, and `detail` holds JSON-serialisable evidence only.
 * - Checks never throw on odd input (all-null extractions, NaN, empty arrays) and never mutate their inputs.
 */
import { CONFIG } from "./config";
import { addDaysIso, daysBetweenIso, formatPct, formatUsd, isIsoDate, maskAccount, normId, round2, toIsoDate } from "./format";
import { type Snapshot, poBalance, remainingBalance } from "./master";
import { findVendorMatches, normalizeDate, normalizeInvoiceNumber } from "./normalize";
import {
  CONFIDENCE_FIELDS,
  STAGE_KEYS,
  STAGE_LABELS,
  type AmountsDetail,
  type AmountsOutcome,
  type ConfidenceField,
  type DecideResult,
  type Decision,
  type DecisionContext,
  type DuplicateDetail,
  type DuplicateOutcome,
  type ExtractDetail,
  type ExtractResult,
  type GroundingResult,
  type InvoiceExtraction,
  type LineItem,
  type NormalizedInvoice,
  type PoLine,
  type PoMatchDetail,
  type PoMatchOutcome,
  type PurchaseOrder,
  type ResultStatus,
  type Severity,
  type SnapshotInvoice,
  type StepMap,
  type StepResult,
  type SuggestPoFn,
  type SuggestPoResult,
  type UploadValidation,
  type ValidateDetail,
  type Vendor,
  type VendorOutcome,
} from "./types";

export type { SuggestPoFn };

/* ================================================================================================
 * Helpers
 * ============================================================================================== */

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const blank = (s: unknown): boolean => typeof s !== "string" || s.trim() === "";

/** Format characters (bidi controls, zero-width, tag characters): never shown, they can make a quoted value read differently from what it is. */
const INVISIBLE_CHARS = /\p{Cf}/gu;

/** Untrusted text -> one short plain line: control and invisible characters dropped, whitespace collapsed, truncated. */
function clip(text: unknown, max = 80): string {
  if (typeof text !== "string") return "";
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code < 0xa0) ? " " : ch;
  }
  const flat = out.replace(INVISIBLE_CHARS, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…` : flat;
}

/** formatUsd that never prints "-$0.00" or "$NaN". */
function money(n: number): string {
  return finite(n) ? formatUsd(n || 0) : "an unreadable amount";
}

/** Rounds to micro-dollars: unit prices below a cent ($0.0549 a label) keep their precision, float noise goes. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** A unit price: whole cents as money() ("$86.20"); more decimals only when the price has them ("$0.0549"). */
function unitMoney(n: number): string {
  if (!finite(n)) return "an unreadable price";
  const micros = Math.round(Math.abs(n) * 1e6);
  if (micros % 10_000 === 0) return money(n);
  const whole = Math.floor(micros / 1e6);
  const fraction = String(micros % 1e6).padStart(6, "0").replace(/0+$/, "");
  return `${n < 0 ? "-" : ""}${formatUsd(whole).replace(/\.00$/, "")}.${fraction}`;
}

/** At most `max` quoted items, then "and N more" (lists built from invoice data never grow without bound). */
function listSome(items: readonly string[], max: number): string {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/** A reason fragment as a sentence ("... (scanned)" -> "... (scanned)."). */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** 0.02 -> "2%", 0.015 -> "1.5%". */
function pctLabel(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

/** A detail object whose required fields are type-checked against `T`, plus extra evidence. */
function detailOf<T extends object>(required: T, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...required, ...extra };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Oldest first (created_at, then id), so "the original" is the first invoice we ever processed. */
function byAge(a: SnapshotInvoice, b: SnapshotInvoice): number {
  return cmp(a.created_at, b.created_at) || cmp(a.id, b.id);
}

/** What the invoice asks the PO to cover: its subtotal, else its total (master.ts consumedAmount: fails safe). Null when neither was read. */
function invoiceAmount(extraction: InvoiceExtraction): { amount: number; label: string } | null {
  if (finite(extraction.subtotal)) return { amount: round2(extraction.subtotal), label: "subtotal" };
  if (finite(extraction.total)) return { amount: round2(extraction.total), label: "total (no subtotal printed)" };
  return null;
}

/** "YYYY-MM-DD" part of a stored ISO timestamp, else null. */
function dayOf(timestamp: string | null): string | null {
  const day = typeof timestamp === "string" ? timestamp.slice(0, 10) : "";
  return isIsoDate(day) ? day : null;
}

/** Whole days between two stored dates, or null when either is missing or not an ISO date. */
function daysApart(a: string | null, b: string | null): number | null {
  if (a === null || b === null || !isIsoDate(a) || !isIsoDate(b)) return null;
  return Math.abs(daysBetweenIso(a, b));
}

/** True when `over` (dollars) is at most CONFIG.priceTolerancePct of `base`, compared in whole cents so exactly 2% passes. */
function withinTolerance(over: number, base: number): boolean {
  const overCents = Math.round(over * 100);
  const baseCents = Math.round(Math.max(base, 0) * 100);
  return overCents <= baseCents * CONFIG.priceTolerancePct + 1e-6;
}

/* ================================================================================================
 * Stage 1: ingest
 * ============================================================================================== */

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Stage 1. upload not ok -> fail with severity upload.outcome and upload.reason. A non-errored invoices
 * row with the same file_hash -> fail/reject "Exact same file already processed in run <run_id>"
 * (rows whose run had a system error do not count, so a re-run after an outage is possible). Else pass.
 * The earliest such row is quoted. Any earlier decision counts, a REJECT included: the same bytes are the same file.
 */
export function checkIngest(upload: UploadValidation, fileHash: string, snapshot: Snapshot): StepResult {
  if (!upload.ok) {
    return {
      status: "fail",
      severity: upload.outcome,
      reason: blank(upload.reason) ? "The file did not pass validation." : upload.reason.trim(),
      detail: { code: upload.code, size_bytes: upload.sizeBytes, page_count: upload.pageCount },
    };
  }
  const hash = typeof fileHash === "string" ? fileHash.trim().toLowerCase() : "";
  const same = hash === "" ? [] : snapshot.invoices.filter((i) => !i.run_had_error && i.file_hash !== null && i.file_hash.toLowerCase() === hash);
  if (same.length > 0) {
    const prior = [...same].sort(byAge)[0];
    const runId = prior.run_id ?? prior.id;
    return {
      status: "fail",
      severity: "reject",
      reason: `Exact same file already processed in run ${runId}`,
      detail: { file_hash: hash, run_id: runId, invoice_number: prior.invoice_number, decision: prior.decision },
    };
  }
  const pages = `${upload.pageCount} page${upload.pageCount === 1 ? "" : "s"}`;
  return {
    status: "pass",
    reason: `Valid PDF (${pages}, ${formatSize(upload.sizeBytes)}); this exact file has not been processed before.`,
    detail: { size_bytes: upload.sizeBytes, page_count: upload.pageCount, file_hash: hash },
  };
}

/* ================================================================================================
 * Stage 3: extract
 * ============================================================================================== */

/**
 * Stage 3. !ok -> status "error": billing_auth -> "LLM provider unavailable (billing/auth)", unreadable ->
 * "Could not read invoice, manual entry required". ok with non-empty suspicious_content -> fail/hold with
 * a reason containing "suspicious" that quotes the content. Else pass. detail: ExtractDetail.
 * Fix round: an error step also records `failure_kind` (billing_auth | unreadable), so nextAction() can tell an
 * outage that a re-run fixes from a document nobody could read (DRILL-2).
 */
export function checkExtract(result: ExtractResult): StepResult {
  if (!result.ok) {
    return {
      status: "error",
      reason: result.kind === "billing_auth" ? "LLM provider unavailable (billing/auth)" : "Could not read invoice, manual entry required",
      detail: detailOf<ExtractDetail>(
        {
          model: result.model,
          latency_ms: result.latencyMs,
          cost_usd: result.costUsd,
          attempts: result.attempts,
          suspicious_content: [],
        },
        { failure_kind: result.kind === "billing_auth" ? "billing_auth" : "unreadable" },
      ),
    };
  }
  const suspicious = Array.isArray(result.data.suspicious_content) ? result.data.suspicious_content : [];
  const detail = detailOf<ExtractDetail>({
    model: result.model,
    latency_ms: result.latencyMs,
    cost_usd: result.costUsd,
    attempts: result.attempts,
    suspicious_content: suspicious,
  });
  if (suspicious.length === 0) {
    return { status: "pass", reason: `Fields extracted by ${clip(result.model, 60) || "the model"}; no suspicious content reported.`, detail };
  }
  const quotes = suspicious.map((s) => clip(s, 160)).filter((s) => s !== "");
  const shown = quotes.slice(0, 3).map((q) => `"${q}"`);
  const more = quotes.length - shown.length;
  const reason =
    quotes.length === 0
      ? "Suspicious content was reported in the document (text unavailable). Held for security review."
      : `Suspicious embedded text found in the document (${suspicious.length}): ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}. Held for security review.`;
  return { status: "fail", severity: "hold", reason, detail };
}

/* ================================================================================================
 * Stage 4: validate
 * ============================================================================================== */

const FIELD_LABELS: Readonly<Record<ConfidenceField, string>> = {
  vendor_name: "vendor name",
  invoice_number: "invoice number",
  invoice_date: "invoice date",
  po_reference: "PO reference",
  total: "total",
};

type ValidateProblemKind = "extraction" | "document_type" | "arithmetic" | "date";

const NOT_INVOICE_LABELS: Readonly<Record<string, string>> = {
  statement: "a statement of account",
  receipt: "a receipt",
  other: "an unrecognised kind of document",
};

function hasValue(extraction: InvoiceExtraction, field: ConfidenceField): boolean {
  switch (field) {
    case "vendor_name":
      return !blank(extraction.vendor_name);
    case "invoice_number":
      return !blank(extraction.invoice_number);
    case "invoice_date":
      return !blank(extraction.invoice_date);
    case "po_reference":
      return !blank(extraction.po_reference);
    case "total":
      return finite(extraction.total);
  }
}

/**
 * Stage 4: lists EVERY problem. HOLD problems: document_type not "invoice" (credit note -> "route to credit
 * process"; statement/receipt/other -> reason containing "not an invoice"), missing vendor/invoice number/
 * date/total, confidence < CONFIG.minFieldConfidence on a critical field that has a value (a score that is
 * not a number in 0..1 counts as low), line sum vs subtotal and subtotal + tax vs total (tax add skipped
 * when tax_inclusive) beyond CONFIG.arithmeticTolerance (a 0.02 difference passes, 0.03 does not),
 * grounding.misses, an invoice date that is not a real or unambiguous date, in the future or older than
 * CONFIG.maxInvoiceAgeDays (relative to `now`, UTC calendar day; exactly 365 days old passes).
 * Info warnings: due date before invoice date or unreadable; grounding === null -> "No text layer to verify
 * against (scanned)". Any HOLD problem -> fail/hold; else any warning -> warn/info; else pass. The reason
 * lists the problems, then the warnings. detail: ValidateDetail.
 * Integration additions (red team): quantity x unit price must equal each line's amount (RT-RULES-01); tax on a
 * zero pre-tax amount, or above CONFIG.maxTaxRate of it plus cents, is a problem (RT-RULES-04);
 * detail.problem_kinds tells nextAction() whether re-keying can help (RT-RULES-07).
 */
export function checkValidate(extraction: InvoiceExtraction, grounding: GroundingResult | null, now: Date): StepResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  /** the same problems grouped by the extraction field they are about (evidence for the run view) */
  const fieldProblems: Record<string, string[]> = {};
  /**
   * What kind of problem each one is, for nextAction(): "extraction" (missing, unreadable, low-confidence or
   * ungrounded values: re-keying helps), "document_type", "arithmetic" (the document's own numbers disagree)
   * and "date" (a readable date outside the allowed range). Only "extraction" means manual data entry.
   */
  const kinds = new Set<ValidateProblemKind>();
  const problem = (field: string, text: string, kind: ValidateProblemKind) => {
    problems.push(text);
    (fieldProblems[field] = fieldProblems[field] ?? []).push(text);
    kinds.add(kind);
  };
  const today = now instanceof Date && Number.isFinite(now.getTime()) ? toIsoDate(now) : null;

  // Document type
  const type: string = extraction.document_type;
  if (type === "credit_note") {
    problem("document_type", "This document is a credit note, not an invoice; route to credit process", "document_type");
  } else if (type !== "invoice") {
    problem("document_type", `This document is not an invoice (it is ${NOT_INVOICE_LABELS[type] ?? "an unrecognised kind of document"})`, "document_type");
  }

  // Required fields
  if (blank(extraction.vendor_name)) problem("vendor_name", "The vendor name is missing", "extraction");
  if (blank(extraction.invoice_number)) problem("invoice_number", "The invoice number is missing", "extraction");
  else if (normalizeInvoiceNumber(extraction.invoice_number) === null) {
    problem("invoice_number", `The invoice number "${clip(extraction.invoice_number, 40)}" has no letters or digits`, "extraction");
  }
  const invoiceDate = normalizeDate(extraction.invoice_date);
  if (blank(extraction.invoice_date)) problem("invoice_date", "The invoice date is missing", "extraction");
  else if (invoiceDate === null) {
    problem("invoice_date", `The invoice date "${clip(extraction.invoice_date, 40)}" is not a valid, unambiguous calendar date`, "extraction");
  }
  if (!finite(extraction.total)) problem("total", "The total is missing", "extraction");

  // Confidence on critical fields that have a value
  for (const field of CONFIDENCE_FIELDS) {
    if (!hasValue(extraction, field)) continue;
    const c: unknown = (extraction.confidence as Partial<Record<ConfidenceField, unknown>> | null | undefined)?.[field];
    if (!finite(c) || c < 0 || c > 1) {
      problem(field, `The ${FIELD_LABELS[field]} has no valid confidence score`, "extraction");
    } else if (c < CONFIG.minFieldConfidence) {
      problem(field, `Low confidence in the ${FIELD_LABELS[field]} (${c.toFixed(2)}, below the ${CONFIG.minFieldConfidence} minimum)`, "extraction");
    }
  }

  // Arithmetic
  const lines = Array.isArray(extraction.line_items) ? extraction.line_items : [];
  const lineSum = lines.length > 0 ? round2(lines.reduce((sum, li) => sum + (finite(li.amount) ? li.amount : 0), 0)) : null;
  const subtotal = finite(extraction.subtotal) ? extraction.subtotal : null;
  const tax = finite(extraction.tax) ? extraction.tax : null;
  const total = finite(extraction.total) ? extraction.total : null;
  // Each line's own arithmetic: a padded line amount ("2 x $1,150.00 = $2,600.00") is billed in full, so it must
  // not pass just because the lines still add up to the subtotal (red team RT-RULES-01).
  const lineMath: string[] = [];
  lines.forEach((li, i) => {
    if (!finite(li.quantity) || !finite(li.unit_price) || !finite(li.amount)) return;
    const expected = round2(li.quantity * li.unit_price);
    if (Math.abs(round2(li.amount - expected)) > CONFIG.arithmeticTolerance) {
      const name = clip(li.description, 40);
      lineMath.push(`line ${i + 1}${name ? ` ("${name}")` : ""}: ${li.quantity} x ${unitMoney(li.unit_price)} = ${money(expected)}, printed as ${money(li.amount)}`);
    }
  });
  if (lineMath.length > 0) {
    problem("line_items", `Quantity times unit price does not give the line amount on ${lineMath.length} line${lineMath.length === 1 ? "" : "s"}: ${listSome(lineMath, 3)}`, "arithmetic");
  }
  if (lineSum !== null && subtotal !== null && Math.abs(round2(lineSum - subtotal)) > CONFIG.arithmeticTolerance) {
    problem("subtotal", `The line items add up to ${money(lineSum)} but the subtotal is ${money(subtotal)}`, "arithmetic");
  }
  const basis = subtotal ?? lineSum;
  let expectedTotal: number | null = null;
  if (basis !== null && total !== null) {
    expectedTotal = round2(extraction.tax_inclusive ? basis : basis + (tax ?? 0));
    if (Math.abs(round2(expectedTotal - total)) > CONFIG.arithmeticTolerance) {
      const what = extraction.tax_inclusive ? "The subtotal (tax included)" : tax !== null ? "The subtotal plus tax" : "The subtotal";
      problem("total", `${what} comes to ${money(expectedTotal)} but the total is ${money(total)}`, "arithmetic");
    }
  }
  // Tax ceiling: POs are pre-tax, so tax is paid with no PO behind it. Tax on nothing, or above the demo tax rate
  // (ASSUMPTIONS.md: 10%) plus cents rounding, holds (red team RT-RULES-04). Lower tax is not this check's concern.
  let pretax: number | null = null;
  if (tax !== null && tax > 0) {
    const gross = basis ?? total;
    pretax = gross === null ? null : round2(extraction.tax_inclusive || basis === null ? gross - tax : gross);
    if (pretax !== null && pretax <= 0) {
      problem("tax", `Tax of ${money(tax)} is charged on a pre-tax amount of ${money(pretax)}`, "arithmetic");
    } else if (pretax !== null && tax > round2(pretax * CONFIG.maxTaxRate) + CONFIG.arithmeticTolerance) {
      problem(
        "tax",
        `Tax of ${money(tax)} is ${formatPct(tax / pretax)} of the ${money(pretax)} pre-tax amount, above the ${pctLabel(CONFIG.maxTaxRate)} tax rate; the PO covers the pre-tax amount only`,
        "arithmetic",
      );
    }
  }

  // Grounding
  if (grounding === null) {
    warnings.push("No text layer to verify against (scanned)");
  } else {
    const misses = Array.isArray(grounding.misses) ? grounding.misses : [];
    // one miss sentence per missing field, in the same order (the field is unknown if the counts disagree)
    const missingFields = (Array.isArray(grounding.fields) ? grounding.fields : []).filter((f) => f.status === "missing").map((f) => f.field as string);
    misses.forEach((miss, i) => problem(missingFields.length === misses.length ? missingFields[i] : "grounding", clip(miss, 300), "extraction"));
    if (misses.length === 0) {
      for (const f of Array.isArray(grounding.fields) ? grounding.fields : []) {
        if (f.status === "missing") {
          problem(f.field, `Extracted ${f.field} ${clip(String(f.value), 60)} does not appear in the document; possible manipulation or misread`, "extraction");
        }
      }
    }
  }

  // Dates against the injected clock
  if (invoiceDate !== null) {
    if (today === null) {
      problem("invoice_date", "The invoice date could not be checked against today's date", "date");
    } else if (invoiceDate > today) {
      problem("invoice_date", `The invoice date ${invoiceDate} is in the future (today is ${today})`, "date");
    } else if (daysBetweenIso(invoiceDate, today) > CONFIG.maxInvoiceAgeDays) {
      problem("invoice_date", `The invoice date ${invoiceDate} is more than ${CONFIG.maxInvoiceAgeDays} days old`, "date");
    }
  }
  if (!blank(extraction.due_date)) {
    const due = normalizeDate(extraction.due_date);
    if (due === null) warnings.push(`The due date "${clip(extraction.due_date, 40)}" could not be read as a date`);
    else if (invoiceDate !== null && due < invoiceDate) warnings.push(`The due date ${due} is before the invoice date ${invoiceDate}`);
  }

  const detail = detailOf<ValidateDetail>(
    { problems, warnings, grounding },
    {
      field_problems: fieldProblems,
      problem_kinds: [...kinds],
      document_type: type,
      line_sum: lineSum,
      expected_total: expectedTotal,
      pretax_amount: pretax,
      today,
    },
  );
  if (problems.length > 0) {
    return { status: "fail", severity: "hold", reason: [...problems, ...warnings].map(sentence).join(" "), detail };
  }
  if (warnings.length > 0) {
    return { status: "warn", severity: "info", reason: warnings.map(sentence).join(" "), detail };
  }
  return { status: "pass", reason: "Required fields are present, the amounts add up and the key values match the document text.", detail };
}

/* ================================================================================================
 * Stage 5: normalize
 * ============================================================================================== */

/** Stage 5: always pass (plan: no fail/warn); reason summarises the normalized number, date and vendor match. detail: the NormalizedInvoice. */
export function checkNormalize(normalized: NormalizedInvoice): StepResult {
  const printed = clip(normalized.invoice_number, 40);
  const number =
    normalized.invoice_number_norm === null
      ? "no usable invoice number"
      : printed === normalized.invoice_number_norm
        ? `invoice number ${printed}`
        : `invoice number ${printed} normalized to ${normalized.invoice_number_norm}`;
  const date = normalized.invoice_date === null ? "no usable invoice date" : `invoice date ${normalized.invoice_date}`;
  const vendor = normalized.vendor_id === null ? "vendor not matched to the vendor master" : `vendor matched to ${normalized.vendor_id}`;
  return { status: "pass", reason: sentence(`Normalized: ${number}; ${date}; ${vendor}`), detail: { ...normalized } };
}

/* ================================================================================================
 * Stage 6: vendor
 * ============================================================================================== */

/**
 * Stage 6. Vendor from normalized.vendor_id. Not found / not approved -> fail/reject with a reason containing
 * "onboarding". Invoice bank (normId) != bank on file -> fail/hold, reason exactly: "Bank details differ from
 * vendor master; call <phone_on_file> (number on file) to verify. Do not use contact details from the invoice."
 * Else pass. Bank details are only ever taken from the master; the invoice value is only compared (and only
 * its masked form is kept as evidence).
 * Two refinements of the plan, both HOLD not REJECT because the vendor is not known to be unknown: no
 * readable vendor name, and a name that matches more than one vendor in the master (never guessed).
 * Fix round (additive, docs/CONTRACT_CHANGES.md):
 * - A document that is not an invoice (statement, receipt, other, credit note) from a vendor that is not in the
 *   master is a warn/info note, and one that names no vendor is skipped: nothing is paid on such a document and
 *   validate already HOLDs it ("not an invoice"), so it is not REJECTed for onboarding (DRILL-1). A known vendor
 *   that is not approved still rejects, a bank mismatch still holds, an ambiguous name still holds.
 * - `printedAccounts` (optional 4th argument): account numbers found in the document's VISIBLE text by
 *   guardrails.printedBankAccounts (null or omitted for a scan). One that is not the bank account on file is a
 *   bank mismatch too, even when the model reported no account or the master's (SEC-2): the bank-change HOLD no
 *   longer rests on a field only the model reads.
 */
export function checkVendor(
  extraction: InvoiceExtraction,
  normalized: NormalizedInvoice,
  snapshot: Snapshot,
  printedAccounts?: readonly string[] | null,
): VendorOutcome {
  const vendor = normalized.vendor_id === null ? null : (snapshot.vendors.find((v) => v.id === normalized.vendor_id) ?? null);
  const printedName = normalized.vendor_name ?? (blank(extraction.vendor_name) ? null : extraction.vendor_name);
  const notInvoice = (extraction.document_type as string) !== "invoice";

  if (vendor === null) {
    if (normalized.vendor_id === null) {
      const matches = findVendorMatches(printedName, snapshot.vendors);
      if (matches.length > 1) {
        return {
          status: "fail",
          severity: "hold",
          reason: `The vendor name "${clip(printedName, 80)}" matches more than one vendor in the master (${matches.map((v) => v.id).join(", ")}), so it cannot be resolved automatically.`,
          detail: { vendor_id: null, ambiguous_vendor_ids: matches.map((v) => v.id), bank_mismatch: false },
          vendor: null,
          bankMismatch: false,
        };
      }
      if (matches.length === 0 && (printedName === null || normalized.vendor_name_norm === null)) {
        if (notInvoice) {
          return {
            status: "skipped",
            reason: "Skipped: this document is not an invoice and names no vendor, so there is no vendor to check.",
            detail: { vendor_id: null, bank_mismatch: false },
            vendor: null,
            bankMismatch: false,
          };
        }
        return {
          status: "fail",
          severity: "hold",
          reason: "The invoice has no readable vendor name, so the vendor cannot be checked against the vendor master.",
          detail: { vendor_id: null, bank_mismatch: false },
          vendor: null,
          bankMismatch: false,
        };
      }
    }
    if (notInvoice) {
      return {
        status: "warn",
        severity: "info",
        reason: `Vendor "${clip(printedName, 80)}" is not in the vendor master; it is not routed to onboarding because this document is not an invoice.`,
        detail: { vendor_id: null, bank_mismatch: false },
        vendor: null,
        bankMismatch: false,
      };
    }
    return {
      status: "fail",
      severity: "reject",
      reason: `Vendor "${clip(printedName, 80)}" is not in the vendor master; route to vendor onboarding before this invoice can be processed.`,
      detail: { vendor_id: null, bank_mismatch: false },
      vendor: null,
      bankMismatch: false,
    };
  }

  const printedBank = normalized.bank_account_norm ?? (blank(extraction.bank_account) ? null : normId(extraction.bank_account ?? "") || null);
  const bankOnFile = blank(vendor.bank_account) ? null : normId(vendor.bank_account ?? "") || null;
  // Account numbers printed in the visible text, whatever the model reported (SEC-2).
  const seen = [...new Set((Array.isArray(printedAccounts) ? printedAccounts : []).map((a) => (typeof a === "string" ? normId(a) : "")).filter((a) => a !== ""))].slice(0, 10);
  const strangers = seen.filter((a) => a !== bankOnFile);
  const bankMismatch = (printedBank !== null && printedBank !== bankOnFile) || strangers.length > 0;
  const detail = {
    vendor_id: vendor.id,
    vendor_name: vendor.name,
    approved: vendor.approved,
    bank_mismatch: bankMismatch,
    invoice_bank: maskAccount(printedBank === null ? null : (extraction.bank_account ?? printedBank)),
    master_bank: maskAccount(vendor.bank_account),
    phone_on_file: vendor.phone_on_file,
    ...(Array.isArray(printedAccounts) ? { printed_accounts: seen.map((a) => maskAccount(a)), printed_account_differs: strangers.length > 0 } : {}),
  };

  if (!vendor.approved) {
    return {
      status: "fail",
      severity: "reject",
      reason: `Vendor ${vendor.name} is not approved; route to vendor onboarding before this invoice can be processed.${bankMismatch ? " The bank account on the invoice also differs from the vendor master." : ""}`,
      detail,
      vendor,
      bankMismatch,
    };
  }
  if (bankMismatch) {
    const phone = blank(vendor.phone_on_file) ? null : (vendor.phone_on_file as string).trim();
    const differ = bankOnFile === null ? "Bank details differ from vendor master (no bank account is on file)" : "Bank details differ from vendor master";
    const reason =
      phone === null
        ? `${differ}; no phone number is on file, so get a verified number from procurement before contacting the vendor. Do not use contact details from the invoice.`
        : `${differ}; call ${phone} (number on file) to verify. Do not use contact details from the invoice.`;
    return { status: "fail", severity: "hold", reason, detail, vendor, bankMismatch };
  }
  const bankNote = printedBank === null && seen.length === 0 ? "; the invoice prints no bank account" : " and the bank account matches the vendor master";
  return { status: "pass", reason: `Vendor ${vendor.name} is approved${bankNote}.`, detail, vendor, bankMismatch };
}

/* ================================================================================================
 * Stage 7: PO match
 * ============================================================================================== */

interface PoResultInput {
  status: ResultStatus;
  severity?: Severity;
  reason: string;
  po?: PurchaseOrder | null;
  inferred?: boolean;
  candidates?: string[];
  suggestion?: SuggestPoResult | null;
  confidence?: number | null;
  reasoning?: string | null;
  extra?: Record<string, unknown>;
}

function poResult(r: PoResultInput): PoMatchOutcome {
  const po = r.po ?? null;
  const inferred = r.inferred ?? false;
  const candidates = r.candidates ?? [];
  const detail = detailOf<PoMatchDetail>(
    { po_number: po?.po_number ?? null, inferred, candidates, confidence: r.confidence ?? null, reasoning: r.reasoning ?? null },
    r.extra,
  );
  return {
    status: r.status,
    ...(r.severity ? { severity: r.severity } : {}),
    reason: r.reason,
    detail,
    po,
    inferred,
    candidates,
    suggestion: r.suggestion ?? null,
  };
}

/**
 * The currency the invoice is in: the normalized code; USD when none is printed (this demo is USD-only);
 * null when one is printed but cannot be read (never silently treated as USD).
 */
function invoiceCurrency(extraction: InvoiceExtraction, normalized: NormalizedInvoice): string | null {
  if (normalized.currency !== null) return normalized.currency;
  return blank(extraction.currency) ? "USD" : null;
}

/** A fail/hold when the invoice currency cannot be compared with, or differs from, the PO's; else null. */
function currencyProblem(extraction: InvoiceExtraction, normalized: NormalizedInvoice, po: PurchaseOrder): string | null {
  const code = invoiceCurrency(extraction, normalized);
  if (code === null) {
    return `The invoice currency "${clip(extraction.currency, 20)}" is not recognised, so it cannot be compared with ${po.po_number} (${po.currency}).`;
  }
  if (code.toUpperCase() !== po.currency.toUpperCase()) {
    return `The invoice currency ${code} does not match ${po.po_number}, which is in ${po.currency}.`;
  }
  return null;
}

/**
 * Stage 7. PO printed -> must exist (normId match), belong to the vendor and be open, else fail/hold.
 * No PO -> candidates = the vendor's open POs with remainingBalance >= the invoice subtotal: 0 -> fail/hold;
 * 1 -> warn/hold "PO inferred as PO-xxxx ..., needs confirmation"; > 1 -> suggestPo({ lineItems, candidates });
 * re-check its po_number is a candidate (else treat as "NONE" -> fail/hold); a pick -> warn/hold
 * "PO inferred as PO-1005 (confidence 0.86), needs confirmation" with the reasoning in detail.
 * Invoice currency (null = USD) != PO currency -> fail/hold. detail: PoMatchDetail.
 * `po` is set only when the PO can be used for the amounts check (found, the vendor's, open, same currency).
 * Skipped (not applicable): no known vendor; a statement, receipt or other non-invoice document; a credit
 * note without a printed PO (no PO is proposed for it). suggestPo is never called for fewer than two
 * candidates, and an exception from it becomes a fail/hold, never a throw.
 */
export async function checkPoMatch(
  extraction: InvoiceExtraction,
  normalized: NormalizedInvoice,
  vendor: Vendor | null,
  snapshot: Snapshot,
  suggestPo: SuggestPoFn,
): Promise<PoMatchOutcome> {
  const type: string = extraction.document_type;
  if (type !== "invoice" && type !== "credit_note") {
    return poResult({ status: "skipped", reason: "Skipped: this document is not an invoice, so there is no PO to match." });
  }
  if (vendor === null) {
    return poResult({ status: "skipped", reason: "Skipped: the vendor is not known, so the PO cannot be checked." });
  }

  // ---- PO printed on the invoice
  const printed = normalized.po_reference_norm;
  if (printed !== null) {
    const shown = clip(normalized.po_reference ?? extraction.po_reference, 40);
    const po = snapshot.pos.find((p) => normId(p.po_number) === printed);
    const fail = (reason: string, problem: string, extra: Record<string, unknown> = {}) =>
      poResult({ status: "fail", severity: "hold", reason, extra: { printed_po: shown, problem, ...extra } });
    if (!po) return fail(`PO "${shown}" printed on the invoice is not in the purchase order master.`, "not_found");
    if (po.vendor_id !== vendor.id) {
      return fail(`${po.po_number} belongs to a different vendor than ${vendor.name}, so this invoice cannot be matched to it.`, "wrong_vendor", {
        found_po: po.po_number,
      });
    }
    if (po.status !== "open") {
      return fail(`${po.po_number} is ${po.status}, so new invoices cannot be matched to it.`, "not_open", { found_po: po.po_number });
    }
    const currency = currencyProblem(extraction, normalized, po);
    if (currency !== null) return fail(currency, "currency", { found_po: po.po_number });
    return poResult({
      status: "pass",
      reason: sentence(`Invoice references ${po.po_number}, an open PO for ${vendor.name}`),
      po,
      extra: { printed_po: shown },
    });
  }

  // ---- No PO printed: infer one
  if (type === "credit_note") {
    return poResult({ status: "skipped", reason: "Skipped: a credit note without a PO reference goes to the credit process, so no PO is proposed." });
  }
  const wanted = invoiceAmount(extraction);
  if (wanted === null) {
    return poResult({
      status: "fail",
      severity: "hold",
      reason: "No PO number is printed on the invoice and no amount could be read, so no PO can be proposed.",
      extra: { problem: "no_amount" },
    });
  }
  const candidates = snapshot.pos.filter(
    (po) => po.vendor_id === vendor.id && po.status === "open" && remainingBalance(po, snapshot.invoices) >= wanted.amount,
  );
  const numbers = candidates.map((po) => po.po_number);
  const list = numbers.join(", ");
  const extra = { problem: "inferred", amount: wanted.amount };

  if (candidates.length === 0) {
    return poResult({
      status: "fail",
      severity: "hold",
      reason: `No PO number is printed on the invoice, and ${vendor.name} has no open PO with at least ${money(wanted.amount)} remaining, so no PO can be proposed.`,
      extra: { ...extra, problem: "no_candidates" },
    });
  }

  const accept = (po: PurchaseOrder, reason: string, more: Partial<PoResultInput>): PoMatchOutcome => {
    const currency = currencyProblem(extraction, normalized, po);
    if (currency !== null) {
      return poResult({ status: "fail", severity: "hold", reason: currency, candidates: numbers, suggestion: more.suggestion, extra: { ...extra, problem: "currency", found_po: po.po_number } });
    }
    return poResult({ status: "warn", severity: "hold", reason, po, inferred: true, candidates: numbers, extra, ...more });
  };

  if (candidates.length === 1) {
    const only = candidates[0];
    return accept(only, `PO inferred as ${only.po_number} (the only open PO for ${vendor.name} with at least ${money(wanted.amount)} remaining), needs confirmation.`, {});
  }

  let suggestion: SuggestPoResult;
  try {
    suggestion = await suggestPo({
      lineItems: (Array.isArray(extraction.line_items) ? extraction.line_items : []).map((li): LineItem => ({ ...li })),
      candidates: candidates.map((po) => ({ po_number: po.po_number, lines: po.lines.map((l): PoLine => ({ ...l })) })),
    });
  } catch {
    suggestion = { ok: false, kind: "failed", message: "PO suggestion failed", costUsd: 0, latencyMs: 0 };
  }
  if (!suggestion.ok) {
    return poResult({
      status: "fail",
      severity: "hold",
      reason: `PO could not be inferred: ${candidates.length} open POs could cover this invoice (${list}) and the PO suggestion was unavailable, so a person must pick the PO.`,
      candidates: numbers,
      suggestion,
      extra: { ...extra, problem: "suggestion_failed", suggestion_failure: suggestion.kind },
    });
  }
  const suggested = typeof suggestion.po_number === "string" ? suggestion.po_number : "";
  const pick = candidates.find((po) => normId(po.po_number) === normId(suggested));
  const confidence = finite(suggestion.confidence) && suggestion.confidence >= 0 && suggestion.confidence <= 1 ? suggestion.confidence : null;
  const reasoning = blank(suggestion.reasoning) ? null : clip(suggestion.reasoning, CONFIG.suggestPoReasoningMaxChars);
  if (!pick) {
    // "NONE", or a PO number that is not one of the candidates (an invented one is never trusted).
    return poResult({
      status: "fail",
      severity: "hold",
      reason: `PO could not be inferred: ${candidates.length} open POs could cover this invoice (${list}) and none was a clear match, so a person must pick the PO.`,
      candidates: numbers,
      suggestion,
      confidence,
      reasoning,
      extra: { ...extra, problem: "no_clear_match", suggested_po: clip(suggested, 40) },
    });
  }
  const shownConfidence = confidence === null ? "confidence unknown" : `confidence ${confidence.toFixed(2)}`;
  return accept(pick, `PO inferred as ${pick.po_number} (${shownConfidence}), needs confirmation.`, { suggestion, confidence, reasoning });
}

/* ================================================================================================
 * Stage 8: amounts
 * ============================================================================================== */

/** Lower-case stemmed words of a line description (plural "s" dropped), so "2 visits" and "visit" share "visit". */
function descriptionWords(description: string): string[] {
  const words = description
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "")
    .map((w) => {
      if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
      if (w.length > 4 && /(?:xes|ches|shes)$/.test(w)) return w.slice(0, -2);
      if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
      return w;
    });
  return [...new Set(words)];
}

/**
 * The PO line an invoice line is about: one description's words are all in the other's, and at least two
 * words are involved (a single generic word only pairs with the identical single word). Best overlap wins.
 */
function pairPoLine(description: string, lines: readonly PoLine[]): PoLine | null {
  const invoiceWords = descriptionWords(description);
  if (invoiceWords.length === 0) return null;
  let best: { line: PoLine; score: number } | null = null;
  for (const line of lines) {
    const poWords = descriptionWords(line.description);
    if (poWords.length === 0) continue;
    const shared = invoiceWords.filter((w) => poWords.includes(w)).length;
    const smaller = Math.min(invoiceWords.length, poWords.length);
    if (shared !== smaller) continue;
    if (smaller < 2 && invoiceWords.length !== poWords.length) continue;
    const score = shared / (invoiceWords.length + poWords.length - shared);
    if (best === null || score > best.score) best = { line, score };
  }
  return best === null ? null : best.line;
}

type PriceSource = "printed" | "amount / quantity";

/**
 * The unit price the line actually charges: the printed one, or amount / quantity when no price is printed or when
 * the amount is above quantity x printed price by more than the rounding of the amount to cents (a padded amount,
 * red team RT-RULES-01). Never rounded to cents (a $0.0549 label must not read as $0.05, RT-RULES-05).
 */
function unitPriceOf(li: LineItem): { price: number; source: PriceSource } | null {
  const printed = finite(li.unit_price) && li.unit_price > 0 ? li.unit_price : null;
  const quantity = finite(li.quantity) && li.quantity > 0 ? li.quantity : null;
  const derived = quantity !== null && finite(li.amount) && li.amount > 0 ? li.amount / quantity : null;
  if (derived !== null && quantity !== null && (printed === null || derived - printed > 0.005 / quantity + 1e-9)) {
    return { price: round6(derived), source: "amount / quantity" };
  }
  return printed === null ? null : { price: printed, source: "printed" };
}

interface LineCheck {
  description: string;
  po_description: string;
  invoice_unit_price: number;
  po_unit_price: number;
  /** where invoice_unit_price comes from: the printed price, or the line amount divided by the quantity */
  price_source: PriceSource;
  /** invoice price minus PO price per unit, in dollars, to the micro-dollar (<= 0 when the invoice is not above the PO) */
  over_by: number;
  /** over_by as a fraction of the PO price, e.g. 0.0141; null for a PO line priced at $0 (anything billed is over) */
  over_pct: number | null;
  within_tolerance: boolean;
}

/** An invoice line with a positive amount that pairs with no line of the PO. */
interface UnmatchedLine {
  description: string;
  amount: number;
}

/**
 * What this invoice bills against ONE PO line, summed over every invoice line that pairs with it (DEC-1): a unit
 * price check alone let 34 toners through on a 20-toner line, a toner line with no quantity, and an add-on whose
 * description contains the PO line's words ("... laptop extended warranty") as long as the PO total had room.
 */
interface LineTotal {
  po_description: string;
  /** what the PO line orders */
  po_quantity: number;
  po_amount: number;
  /** summed over the paired invoice lines; null when one of them prints no quantity (the amount still counts) */
  billed_quantity: number | null;
  billed_amount: number;
  /** how many invoice lines pair with this PO line */
  invoice_lines: number;
  /** more units billed than ordered, beyond the tolerance (not judged for a lump-sum line of quantity 1) */
  quantity_over: boolean;
  /** billed amount over the PO line's amount as a fraction, e.g. 0.7 (<= 0 when not over) */
  amount_over_pct: number;
  within_tolerance: boolean;
}

/** 34 -> "34", 2.5 -> "2.5", 200000 -> "200,000" (an invoice quantity, at most 4 decimals). */
const QUANTITY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
function quantityLabel(n: number): string {
  return finite(n) ? QUANTITY.format(n) : "an unreadable quantity";
}

/**
 * A percentage over a limit, never printed as the limit itself: +2.01% must not read "+2.0%, above the 2%
 * tolerance" (DEC-10). One decimal, more only when that one would round down to the tolerance.
 */
function overPctLabel(fraction: number, beyond: boolean): string {
  const tolerance = CONFIG.priceTolerancePct * 100;
  for (let digits = 1; digits <= 4; digits++) {
    const text = (fraction * 100).toFixed(digits);
    if (!beyond || Number.parseFloat(text) > tolerance) return `${text}%`;
  }
  return `${(fraction * 100).toFixed(4)}%`;
}

/**
 * Every invoice line against the PO's lines. A line that pairs gets its unit price variance (exact prices, no
 * rounding to cents: the 2% is a ratio, RT-RULES-05); one that pairs with a $0 PO line ("included") is over by
 * whatever it bills. A billed line that pairs with nothing is collected as unmatched instead of being dropped
 * (RT-RULES-03). Under-billing is never flagged; lines with no positive amount bill nothing.
 * Every billed line that pairs with a priced PO line also counts toward that line's total (quantity and amount,
 * DEC-1), whether or not a unit price can be worked out for it.
 */
function compareLines(
  extraction: InvoiceExtraction,
  po: PurchaseOrder,
): { checks: LineCheck[]; unmatched: UnmatchedLine[]; billed: number; totals: LineTotal[] } {
  const checks: LineCheck[] = [];
  const unmatched: UnmatchedLine[] = [];
  const sums = new Map<PoLine, { quantity: number; quantityKnown: boolean; amount: number; lines: number }>();
  let billed = 0;
  for (const li of Array.isArray(extraction.line_items) ? extraction.line_items : []) {
    const amount = finite(li.amount) && li.amount > 0 ? li.amount : 0;
    billed += amount;
    const description = typeof li.description === "string" ? li.description : "";
    const poLine = pairPoLine(description, po.lines);
    if (poLine === null) {
      if (amount > 0) unmatched.push({ description: clip(description, 60) || "(no description)", amount: round2(amount) });
      continue;
    }
    if (amount > 0 && finite(poLine.amount) && poLine.amount > 0) {
      const sum = sums.get(poLine) ?? { quantity: 0, quantityKnown: true, amount: 0, lines: 0 };
      sum.amount += amount;
      sum.lines += 1;
      if (finite(li.quantity) && li.quantity > 0) sum.quantity += li.quantity;
      else sum.quantityKnown = false;
      sums.set(poLine, sum);
    }
    const effective = unitPriceOf(li);
    const base = { description: clip(description, 60), po_description: clip(poLine.description, 60) };
    if (!finite(poLine.unit_price) || poLine.unit_price <= 0) {
      if (amount <= 0) continue; // an included line that is not charged for
      const price = effective?.price ?? round2(amount);
      checks.push({ ...base, invoice_unit_price: price, po_unit_price: 0, price_source: effective?.source ?? "amount / quantity", over_by: price, over_pct: null, within_tolerance: false });
      continue;
    }
    if (effective === null) continue; // paired, but no unit price can be worked out
    const ratio = (effective.price - poLine.unit_price) / poLine.unit_price;
    checks.push({
      ...base,
      invoice_unit_price: effective.price,
      po_unit_price: poLine.unit_price,
      price_source: effective.source,
      over_by: round6(effective.price - poLine.unit_price),
      over_pct: Math.round(ratio * 10000) / 10000,
      within_tolerance: ratio <= CONFIG.priceTolerancePct + 1e-9,
    });
  }
  const totals: LineTotal[] = [...sums].map(([poLine, sum]) => {
    const billedAmount = round2(sum.amount);
    const billedQuantity = sum.quantityKnown ? round6(sum.quantity) : null;
    // A lump sum (quantity 1, CONTRACTS 3.1) has no units to count: only its amount is compared.
    const countsUnits = finite(poLine.quantity) && poLine.quantity > 1;
    const quantityOver = countsUnits && billedQuantity !== null && billedQuantity > poLine.quantity * (1 + CONFIG.priceTolerancePct) + 1e-9;
    const amountOver = round2(billedAmount - poLine.amount);
    const amountFails = amountOver > 0 && !withinTolerance(amountOver, poLine.amount);
    return {
      po_description: clip(poLine.description, 60),
      po_quantity: poLine.quantity,
      po_amount: poLine.amount,
      billed_quantity: billedQuantity,
      billed_amount: billedAmount,
      invoice_lines: sum.lines,
      quantity_over: quantityOver,
      amount_over_pct: Math.round((amountOver / poLine.amount) * 10000) / 10000,
      within_tolerance: !quantityOver && !amountFails,
    };
  });
  return { checks, unmatched, billed: round2(billed), totals };
}

/** One reason sentence for a unit price above its PO line's. */
function priceSentence(c: LineCheck, po: PurchaseOrder, tolerance: string): string {
  const derived = c.price_source === "amount / quantity" ? "; worked out as the line amount over the quantity" : "";
  if (c.po_unit_price <= 0) {
    return `"${c.description}" is billed at ${unitMoney(c.invoice_unit_price)} a unit, but ${po.po_number} lists "${c.po_description}" at $0.00 (included at no charge)${derived}.`;
  }
  const pct = c.over_pct === null ? "" : `+${overPctLabel(c.over_by / c.po_unit_price, !c.within_tolerance)}, `;
  return `Unit price for "${c.description}" is ${unitMoney(c.invoice_unit_price)} vs ${unitMoney(c.po_unit_price)} on ${po.po_number} (${pct}${c.within_tolerance ? "within" : "above"} the ${tolerance} tolerance${derived}).`;
}

/** One reason sentence for a PO line that this invoice bills beyond what was ordered (DEC-1). */
function lineTotalSentence(t: LineTotal, po: PurchaseOrder, tolerance: string): string {
  const billed =
    t.billed_quantity === null ? `${money(t.billed_amount)} with no quantity printed` : `${quantityLabel(t.billed_quantity)} for ${money(t.billed_amount)}`;
  const across = t.invoice_lines > 1 ? ` on ${t.invoice_lines} invoice lines` : "";
  const amountBeyond = t.amount_over_pct > 0 && !withinTolerance(round2(t.billed_amount - t.po_amount), t.po_amount);
  const why = [
    t.quantity_over ? "more units than ordered" : null,
    amountBeyond ? `+${overPctLabel(round2(t.billed_amount - t.po_amount) / t.po_amount, true)} over the line's value` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" and ");
  return `"${t.po_description}" on ${po.po_number}: ${quantityLabel(t.po_quantity)} ordered for ${money(t.po_amount)}, but this invoice bills ${billed}${across} (${why}, above the ${tolerance} tolerance).`;
}

/** How many approved invoice numbers the evidence keeps (a blanket PO can have hundreds, RT-RULES-08). */
const MAX_LISTED_INVOICES = 20;

/**
 * Stage 8. No PO -> skipped. Subtotal (total when no subtotal was printed) vs remainingBalance(po,
 * snapshot.invoices): over by <= CONFIG.priceTolerancePct of the remaining (exactly 2% passes) -> warn/info
 * with a reason containing "tolerance"; more -> fail/hold, e.g. "Exceeds remaining PO balance by $3,000.00.
 * PO-1003: $30,000.00 total, $24,000.00 already approved (GLX-301, GLX-302), $6,000.00 remaining." Nothing
 * remaining means no tolerance at all. Per-line unit price vs the PO line with the matching description
 * (same 2% rule, in cents): a price above the PO's by up to 2% (exactly 2% included) is a warn/info note
 * "within the 2% tolerance"; more than 2% above is fail/hold "above the 2% tolerance" (the plan table says
 * "> 2% over -> warn"; ASSUMPTIONS.md applies the tolerance to the line price too, so beyond it holds: a 30%
 * price rise must not be approved just because the PO total has room). Lower prices are never flagged.
 * Amounts via format.ts formatUsd. overBy is the amount over the remaining balance (> 0), else null.
 * detail: AmountsDetail (over_pct is a fraction, e.g. 0.0083) plus lines, tolerance_pct, within_tolerance
 * (balance) and price_within_tolerance (lines). A tax-inclusive invoice is compared as printed
 * (conservative: the PO is pre-tax).
 * Integration additions (red team): the unit price compared is the one the line charges (amount / quantity when
 * the amount is padded, RT-RULES-01), compared exactly as a ratio, never rounded to cents (RT-RULES-05); billed
 * lines that are not on the PO are listed (unmatched_lines) and hold when they are more than the tolerance share
 * of the billed lines, and a line the PO includes at $0 that is billed holds (RT-RULES-03); the approved invoices
 * named in the reason and kept in detail are capped (approved_invoice_count keeps the total, RT-RULES-08).
 * Fix round (DEC-1): the invoice lines that pair with one PO line are added up. More units than that PO line orders
 * (beyond the 2% tolerance; a lump-sum line of quantity 1 is judged on its amount only), or a billed amount more than
 * 2% above the PO line's amount, holds: extra units, a line with no quantity and an add-on whose description contains
 * the PO line's words are no longer approved just because the PO total has room. detail.line_totals /
 * line_totals_within_tolerance carry the evidence. A tax-inclusive invoice whose price is above the PO's says next to
 * the price sentence that its prices include tax (DEC-5).
 */
export function checkAmounts(
  extraction: InvoiceExtraction,
  normalized: NormalizedInvoice,
  poMatch: PoMatchOutcome,
  snapshot: Snapshot,
): AmountsOutcome {
  const po = poMatch.po;
  const skipped = (reason: string): AmountsOutcome => ({
    status: "skipped",
    reason,
    detail: detailOf<AmountsDetail>({
      po_number: po?.po_number ?? null,
      po_subtotal: null,
      already_approved: null,
      approved_invoices: [],
      remaining: null,
      invoice_subtotal: null,
      over_by: null,
      over_pct: null,
    }),
    remaining: null,
    overBy: null,
  });
  if (po === null) return skipped("Skipped: no PO was matched, so there is no balance to check against.");
  const wanted = invoiceAmount(extraction);
  if (wanted === null) return skipped(`Skipped: no invoice amount was read, so it cannot be compared with ${po.po_number}.`);

  const balance = poBalance(po, snapshot.invoices);
  const remaining = balance.remaining;
  const over = round2(wanted.amount - remaining);
  const overBy = over > 0 ? over : null;
  const overPct = overBy !== null && remaining > 0 ? Math.round((overBy / remaining) * 10000) / 10000 : null;
  const within = overBy === null || withinTolerance(overBy, remaining);
  const tolerance = pctLabel(CONFIG.priceTolerancePct);
  const { checks: lineChecks, unmatched, billed, totals: lineTotals } = compareLines(extraction, po);
  // Lines priced above the PO's. The ones beyond the tolerance come first: they are what holds the invoice.
  const above = lineChecks.filter((c) => c.over_by > 0).sort((a, b) => Number(a.within_tolerance) - Number(b.within_tolerance));
  const priceFails = above.some((c) => !c.within_tolerance);
  const lineNotes = above.map((c) => priceSentence(c, po, tolerance));
  const shownNotes = lineNotes.slice(0, 3);
  if (lineNotes.length > shownNotes.length) shownNotes.push(`${lineNotes.length - shownNotes.length} more line prices are above the PO's.`);
  // A tax-inclusive invoice is compared as printed (the PO is pre-tax): a price above the PO's says so next to it (DEC-5).
  const taxPriceNote = extraction.tax_inclusive === true && above.length > 0 ? "The invoice prices include tax and the PO prices are pre-tax, so they are compared as printed." : null;
  const priceSentences = taxPriceNote === null ? shownNotes : [...shownNotes, taxPriceNote];

  // What this invoice bills against each PO line, in quantity and in value (DEC-1).
  const overLines = lineTotals.filter((x) => !x.within_tolerance);
  const totalsFail = overLines.length > 0;
  const totalSentences = overLines.slice(0, 3).map((x) => lineTotalSentence(x, po, tolerance));
  if (overLines.length > totalSentences.length) totalSentences.push(`${overLines.length - totalSentences.length} more PO lines are billed beyond what was ordered.`);

  // Billed lines that are not on the PO at all: more than the tolerance (as a share of the billed lines) holds.
  const unmatchedTotal = round2(unmatched.reduce((sum, u) => sum + u.amount, 0));
  const unmatchedShare = billed > 0 ? unmatchedTotal / billed : 0;
  const unmatchedFails = unmatchedTotal > 0 && unmatchedShare > CONFIG.priceTolerancePct + 1e-9;
  const unmatchedSentence =
    unmatched.length === 0
      ? null
      : `Not on ${po.po_number}: ${listSome(unmatched.map((u) => `"${u.description}" (${money(u.amount)})`), 3)}; ${money(unmatchedTotal)} (${formatPct(unmatchedShare)} of the billed lines) has no matching PO line, ${unmatchedFails ? "above" : "within"} the ${tolerance} tolerance.`;

  const balanceFails = overBy !== null && !within;
  let balanceSentence: string;
  if (overBy === null) {
    balanceSentence = `Invoice ${wanted.label} ${money(wanted.amount)} is within the ${money(remaining)} remaining on ${po.po_number}; ${money(round2(remaining - wanted.amount))} would be left.`;
  } else if (within) {
    balanceSentence = `Invoice ${wanted.label} ${money(wanted.amount)} is ${money(overBy)} (${formatPct(overBy / remaining)}) over the ${money(remaining)} remaining on ${po.po_number}, within the ${tolerance} tolerance.`;
  } else {
    const numbers = balance.approved_invoices.map((n) => clip(n, 40));
    const approved = numbers.length > 0 ? ` (${listSome(numbers, 5)})` : "";
    balanceSentence =
      `Exceeds remaining PO balance by ${money(overBy)}. ${po.po_number}: ${money(po.subtotal)} total, ${money(balance.invoiced)} already approved${approved}, ${money(remaining)} remaining.` +
      ` Invoice ${wanted.label} ${money(wanted.amount)} is more than the ${tolerance} tolerance over the remaining balance.`;
  }
  const failed = balanceFails || priceFails || unmatchedFails || totalsFail;
  const status: ResultStatus = failed ? "fail" : overBy !== null || lineNotes.length > 0 || unmatched.length > 0 ? "warn" : "pass";
  const severity: Severity | undefined = failed ? "hold" : status === "warn" ? "info" : undefined;
  // reasons[0] must explain the decision: what fails leads (balance, then prices, then quantities and values per PO
  // line, then lines not on the PO).
  const decisive = [
    ...(balanceFails ? [balanceSentence] : []),
    ...(priceFails ? priceSentences : []),
    ...totalSentences,
    ...(unmatchedFails && unmatchedSentence ? [unmatchedSentence] : []),
  ];
  const rest = [...(balanceFails ? [] : [balanceSentence]), ...(priceFails ? [] : priceSentences), ...(!unmatchedFails && unmatchedSentence ? [unmatchedSentence] : [])];
  const parts = [...decisive, ...rest];
  if (extraction.tax_inclusive && overBy !== null && taxPriceNote === null) parts.push("The invoice amounts include tax, the PO is pre-tax.");

  return {
    status,
    ...(severity ? { severity } : {}),
    reason: parts.join(" "),
    detail: detailOf<AmountsDetail>(
      {
        po_number: po.po_number,
        po_subtotal: po.subtotal,
        already_approved: balance.invoiced,
        approved_invoices: balance.approved_invoices.slice(0, MAX_LISTED_INVOICES),
        remaining,
        invoice_subtotal: wanted.amount,
        over_by: overBy,
        over_pct: overPct,
      },
      {
        approved_invoice_count: balance.approved_invoices.length,
        amount_source: wanted.label,
        tolerance_pct: CONFIG.priceTolerancePct,
        within_tolerance: within,
        price_within_tolerance: !priceFails,
        unmatched_within_tolerance: !unmatchedFails,
        tax_inclusive: extraction.tax_inclusive === true,
        lines: lineChecks,
        unmatched_lines: unmatched,
        unmatched_total: unmatchedTotal,
        line_totals: lineTotals,
        line_totals_within_tolerance: !totalsFail,
      },
    ),
    remaining,
    overBy,
  };
}

/* ================================================================================================
 * Stage 9: duplicates
 * ============================================================================================== */

/** The comparison number of an earlier invoice row (stored norm, else normalized from the printed number). */
function rowKey(row: SnapshotInvoice): string | null {
  if (row.invoice_number_norm !== null && row.invoice_number_norm !== "") return row.invoice_number_norm;
  return row.invoice_number === null ? null : normalizeInvoiceNumber(row.invoice_number);
}

/** What an earlier invoice row asked of its PO: subtotal, else total (the same rule as invoiceAmount). */
function rowAmount(row: SnapshotInvoice): number | null {
  if (finite(row.subtotal)) return round2(row.subtotal);
  if (finite(row.total)) return round2(row.total);
  return null;
}

type ChargeClass = "charge" | "credit";

/**
 * Credit notes are compared with credit notes and invoices with invoices (DEC-3): a credit note that carries the
 * number of the invoice it credits is not a second charge. This document: a credit when it says it is a credit note
 * or its amount is negative. An earlier row (the invoices table keeps no document type): by the sign of its amount,
 * or null when it has none (null matches either, so a row without amounts still matches by number).
 */
function chargeClassOf(extraction: InvoiceExtraction): ChargeClass {
  const amount = invoiceAmount(extraction)?.amount ?? null;
  return extraction.document_type === "credit_note" || (amount !== null && amount < 0) ? "credit" : "charge";
}
function rowClassOf(row: SnapshotInvoice): ChargeClass | null {
  const amount = rowAmount(row);
  return amount === null ? null : amount < 0 ? "credit" : "charge";
}

/**
 * An invoice number as a person reads it (DEC-2): NFKC, upper case, split into its alphanumeric parts; the letter O
 * read as 0 and I or L as 1; zeros that only pad a run of digits dropped; the parts joined. "INV-O042", "INV-42",
 * "INV-00042" and "1NV-0042" all read as INV-0042 ("1NV42"); "INV-0043" and "INV-0042A" do not. normalizeInvoiceNumber
 * (the hard key) stays as it is; this second key only HOLDs.
 */
function lookalikeKey(printed: string | null): string | null {
  if (printed === null) return null;
  const parts = printed
    .normalize("NFKC")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((p) => p !== "")
    .map((p) => p.replace(/O/g, "0").replace(/[IL]/g, "1").replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, "")));
  const key = parts.join("");
  return key === "" ? null : key;
}

/**
 * The charge two invoices have in common, compared like with like (red team RT-RULES-02): subtotals when both
 * printed one; totals when either did not (never one invoice's subtotal against the other's total: the same
 * $2,300 + $230 charge printed with and without a subtotal line is still the same $2,530); else the old
 * subtotal-else-total rule. Returns the matching figure and what it is, or null.
 */
function sameCharge(extraction: InvoiceExtraction, wanted: { amount: number }, row: SnapshotInvoice): { amount: number; what: "" | "total " } | null {
  const sub = finite(extraction.subtotal) ? round2(extraction.subtotal) : null;
  const rowSub = finite(row.subtotal) ? round2(row.subtotal) : null;
  if (sub !== null && rowSub !== null) return sub === rowSub ? { amount: sub, what: "" } : null;
  const total = finite(extraction.total) ? round2(extraction.total) : null;
  const rowTotal = finite(row.total) ? round2(row.total) : null;
  if (total !== null && rowTotal !== null) return total === rowTotal ? { amount: total, what: "total " } : null;
  return rowAmount(row) === wanted.amount ? { amount: wanted.amount, what: "" } : null;
}

/**
 * Stage 9, against the vendor's earlier invoices (decision APPROVE or HOLD, run_had_error false: a REJECTed
 * invoice may be resubmitted, a run that hit a system error never counted). Hard: same invoice_number_norm
 * -> fail/reject "Duplicate of INV-0042 (processed 2026-10-05); numbers differ only in formatting". Soft:
 * same subtotal (total when none), different number, invoice dates within CONFIG.softDuplicateWindowDays
 * (7 days apart still counts, 8 does not; unknown dates count as within) -> fail/hold. Same amount further
 * apart -> pass with a reason containing "recurring pattern, not a duplicate". Skipped when the vendor is
 * not known. detail: DuplicateDetail. "Same amount" compares like with like (sameCharge, RT-RULES-02):
 * subtotals when both invoices printed one, totals when either did not.
 * Fix round: skipped for a statement, receipt or other non-invoice document (nothing is paid on it, so it repeats
 * nothing; validate HOLDs it); a credit note is compared only with earlier credits and an invoice only with earlier
 * charges (chargeClassOf, DEC-3); after the hard rule, a number that differs from an earlier one only by look-alike
 * characters or zero padding (lookalikeKey) is fail/hold, kind "soft", detail.lookalike true, whatever the amount and
 * the date (DEC-2).
 */
export function checkDuplicate(
  extraction: InvoiceExtraction,
  normalized: NormalizedInvoice,
  vendor: Vendor | null,
  snapshot: Snapshot,
): DuplicateOutcome {
  const none = (status: ResultStatus, reason: string, extra: Partial<DuplicateDetail> = {}): DuplicateOutcome => ({
    status,
    reason,
    detail: detailOf<DuplicateDetail>({ match: null, recurring: null, ...extra }),
    duplicateOf: null,
    kind: null,
  });
  if (vendor === null) return none("skipped", "Skipped: the vendor is not known, so there are no earlier invoices to compare with.");
  const type: string = extraction.document_type;
  if (type !== "invoice" && type !== "credit_note") {
    return none("skipped", "Skipped: this document is not an invoice, so it is not compared with earlier invoices.");
  }

  const incoming = chargeClassOf(extraction);
  const earlier = snapshot.invoices
    .filter((i) => i.vendor_id === vendor.id && !i.run_had_error && (i.decision === "APPROVE" || i.decision === "HOLD"))
    .filter((i) => {
      const cls = rowClassOf(i);
      return cls === null || cls === incoming;
    })
    .sort(byAge);
  const key = normalized.invoice_number_norm;
  const printed = normalized.invoice_number ?? extraction.invoice_number;

  // Hard duplicate: the same invoice number once formatting is ignored.
  const hard = key === null ? undefined : earlier.find((i) => rowKey(i) === key);
  if (hard) {
    const original = clip(hard.invoice_number ?? printed ?? hard.invoice_number_norm, 60);
    const processed = dayOf(hard.created_at) ?? hard.invoice_date;
    const dated = hard.invoice_date !== null && hard.invoice_date !== processed ? `, dated ${hard.invoice_date}` : "";
    const how = hard.invoice_number !== null && printed !== null && hard.invoice_number === printed ? "the same invoice number was already processed" : "numbers differ only in formatting";
    return {
      status: "fail",
      severity: "reject",
      reason: `Duplicate of ${original} (processed ${processed ?? "earlier"}${dated}); ${how}.`,
      detail: detailOf<DuplicateDetail>(
        { match: { kind: "hard", invoice_number: hard.invoice_number, invoice_date: hard.invoice_date, run_id: hard.run_id ?? hard.id }, recurring: null },
        { original_decision: hard.decision },
      ),
      duplicateOf: hard,
      kind: "hard",
    };
  }

  // A number that only LOOKS different (O for 0, I or L for 1, zero padding): held whatever the amount and the date (DEC-2).
  const look = key === null ? null : lookalikeKey(printed);
  const twin = look === null ? undefined : earlier.find((i) => rowKey(i) !== key && lookalikeKey(i.invoice_number ?? i.invoice_number_norm) === look);
  if (twin) {
    const original = clip(twin.invoice_number ?? twin.invoice_number_norm ?? twin.id, 60);
    const days = daysApart(normalized.invoice_date, twin.invoice_date);
    return {
      status: "fail",
      severity: "hold",
      reason: `Possible duplicate of ${original} (dated ${twin.invoice_date ?? "unknown"}): the invoice number "${clip(printed, 40)}" differs from it only by look-alike characters (O for 0, I or L for 1) or leading zeros.`,
      detail: detailOf<DuplicateDetail>(
        { match: { kind: "soft", invoice_number: twin.invoice_number, invoice_date: twin.invoice_date, run_id: twin.run_id ?? twin.id }, recurring: null },
        { lookalike: true, days_apart: days, original_decision: twin.decision },
      ),
      duplicateOf: twin,
      kind: "soft",
    };
  }

  // Same charge, different number: a soft duplicate when close in time, a recurring charge when not.
  const wanted = invoiceAmount(extraction);
  const sameAmount =
    wanted === null
      ? []
      : earlier.flatMap((row) => {
          const charge = sameCharge(extraction, wanted, row);
          return charge === null ? [] : [{ row, charge, days: daysApart(normalized.invoice_date, row.invoice_date) }];
        });
  const near = sameAmount.filter((c) => c.days === null || c.days <= CONFIG.softDuplicateWindowDays);
  if (wanted !== null && near.length > 0) {
    const closest = [...near].sort((a, b) => (a.days ?? Number.MAX_SAFE_INTEGER) - (b.days ?? Number.MAX_SAFE_INTEGER))[0];
    const original = clip(closest.row.invoice_number ?? closest.row.id, 60);
    const gap = closest.days === null ? "on an unknown date" : closest.days === 0 ? "on the same day" : `${closest.days} day${closest.days === 1 ? "" : "s"} apart`;
    return {
      status: "fail",
      severity: "hold",
      reason: `Possible duplicate of ${original} (dated ${closest.row.invoice_date ?? "unknown"}): same vendor and ${closest.charge.what}${money(closest.charge.amount)}, ${gap}, but a different invoice number.`,
      detail: detailOf<DuplicateDetail>(
        {
          match: { kind: "soft", invoice_number: closest.row.invoice_number, invoice_date: closest.row.invoice_date, run_id: closest.row.run_id ?? closest.row.id },
          recurring: null,
        },
        { days_apart: closest.days, window_days: CONFIG.softDuplicateWindowDays, original_decision: closest.row.decision },
      ),
      duplicateOf: closest.row,
      kind: "soft",
    };
  }
  const far = sameAmount.filter((c) => c.days !== null).sort((a, b) => (a.days as number) - (b.days as number))[0];
  if (wanted !== null && far && far.days !== null) {
    const original = clip(far.row.invoice_number ?? far.row.id, 60);
    return none(
      "pass",
      `Same vendor and ${far.charge.what === "" ? "amount" : "total"} (${money(far.charge.amount)}) as ${original} (dated ${far.row.invoice_date ?? "unknown"}, ${far.days} days apart), but a different invoice number and more than ${CONFIG.softDuplicateWindowDays} days apart: recurring pattern, not a duplicate.`,
      { recurring: { invoice_number: far.row.invoice_number, invoice_date: far.row.invoice_date, days_apart: far.days } },
    );
  }
  return none("pass", "No earlier invoice from this vendor has the same invoice number or the same amount.");
}

/* ================================================================================================
 * Stage 10: decide + next action
 * ============================================================================================== */

/** Screen failed, or the model reported suspicious content (checked on the extraction and on the extract step's detail). */
function isSecurityFlagged(steps: StepMap, ctx: DecisionContext): boolean {
  if (steps.screen?.status === "fail") return true;
  const reported = ctx.extraction?.suspicious_content;
  if (Array.isArray(reported) && reported.length > 0) return true;
  const detailed = steps.extract?.detail?.suspicious_content;
  return Array.isArray(detailed) && detailed.length > 0;
}

const SECURITY_HOLD_REASON = "Held for security review: the document was flagged as suspicious, so it cannot be approved automatically.";

/**
 * Stage 10 (plan section 7 precedence; severity drives it, status is presentation):
 * 1. any fail with severity "reject" -> REJECT
 * 2. any fail or warn with severity "hold" (a fail without severity, or with "info", counts as hold) -> HOLD
 * 3. any step "error" -> HOLD (its reason, e.g. "System error at PO match, manual review")
 * 4. otherwise APPROVE (warnings become notes)
 * reasons = every fail + warn + error reason, decisive first (reject, then hold/error, then info), stage
 * order within each group. securityFlag = steps.screen failed OR ctx.extraction.suspicious_content non-empty
 * (also read from the extract step's detail); MUST force HOLD when the precedence alone would APPROVE
 * (invariant: securityFlag => never APPROVE), with its own reason first.
 */
export function decide(steps: StepMap, ctx: DecisionContext): DecideResult {
  const rejects: string[] = [];
  const holds: string[] = [];
  const notes: string[] = [];
  for (const key of STAGE_KEYS) {
    if (key === "decide") continue;
    const step = steps[key];
    if (!step) continue;
    const reason = blank(step.reason) ? `${STAGE_LABELS[key]} needs manual review` : step.reason;
    if (step.status === "fail") (step.severity === "reject" ? rejects : holds).push(reason);
    else if (step.status === "error") holds.push(reason);
    else if (step.status === "warn") (step.severity === "info" || step.severity === undefined ? notes : holds).push(reason);
  }
  const securityFlag = isSecurityFlagged(steps, ctx);
  let decision: Decision = rejects.length > 0 ? "REJECT" : holds.length > 0 ? "HOLD" : "APPROVE";
  if (securityFlag && decision === "APPROVE") {
    decision = "HOLD";
    holds.push(SECURITY_HOLD_REASON);
  }
  return { decision, reasons: [...rejects, ...holds, ...notes], securityFlag };
}

/**
 * Did this stage find a business problem: a fail, or a warning with severity hold. A stage that crashed
 * (status "error") found nothing, so it gets the fallback advice, never "this repeats an earlier invoice".
 */
function needsAttention(step: StepResult | undefined): step is StepResult {
  return step !== undefined && (step.status === "fail" || (step.status === "warn" && step.severity === "hold"));
}

/**
 * A failed validate step calls for manual data entry when one of its problems is about reading the document
 * (detail.problem_kinds includes "extraction"). A step that does not classify its problems keeps the old,
 * conservative answer (manual entry).
 */
function needsManualEntry(step: StepResult): boolean {
  const kinds = (step.detail as { problem_kinds?: unknown } | undefined)?.problem_kinds;
  return !Array.isArray(kinds) || kinds.includes("extraction");
}

/**
 * The printed due date, else invoice date + payment terms. A printed due date BEFORE the invoice date (validate notes
 * it: a misread or a typo) is not used, so payment is never scheduled as if it were already overdue (DEC-9).
 */
function queueForPayment(ctx: DecisionContext): string {
  const printedDue = normalizeDate(ctx.extraction?.due_date ?? null);
  const invoiceDate = ctx.normalized?.invoice_date ?? normalizeDate(ctx.extraction?.invoice_date ?? null);
  if (printedDue !== null && (invoiceDate === null || printedDue >= invoiceDate)) return `Queue for payment on due date ${printedDue}.`;
  if (invoiceDate !== null) {
    const ignored = printedDue !== null ? `; the printed due date ${printedDue} is before the invoice date, so it is not used` : "";
    return `Queue for payment on due date ${addDaysIso(invoiceDate, CONFIG.paymentTermsDays)} (${CONFIG.paymentTermsDays} days after the invoice date${ignored}).`;
  }
  return `Queue for payment on the standard ${CONFIG.paymentTermsDays}-day terms.`;
}

/**
 * Decision card next action (plan section 7 table), from the first problem in this priority:
 * security -> duplicate -> vendor -> bank -> extraction -> document type -> PO -> amounts; APPROVE ->
 * "Queue for payment on due date <due_date, else invoice_date + CONFIG.paymentTermsDays>." For a
 * non-invoice document_type, route by document type even if fields are missing. A security flag wins even
 * over an APPROVE passed in by mistake. After the plan's rows, an ingest failure gets its own advice (ask
 * for a valid or unlocked PDF); a soft duplicate says "check whether this repeats" rather than "already
 * processed". Fallback: "Review the reasons above."
 * Fix round: an extraction that failed because the AI service was unavailable (billing/auth) says a re-run works
 * (DRILL-2); a vendor that could not be resolved on a non-invoice document no longer means manual entry, so the
 * document routes by its type (DRILL-1); more units or value on a PO line than ordered (DEC-1) and a tax-inclusive
 * price above the PO's (DEC-5) get their own amounts advice.
 */
export function nextAction(decision: Decision, steps: StepMap, ctx: DecisionContext): string {
  if (isSecurityFlagged(steps, ctx)) {
    return "Send to finance security review. Do not contact the vendor using details from this document.";
  }
  if (decision === "APPROVE") return queueForPayment(ctx);

  // duplicate
  if (needsAttention(steps.duplicate)) {
    const matched = ctx.duplicate?.duplicateOf ?? null;
    const detailMatch = (steps.duplicate.detail as Partial<DuplicateDetail> | undefined)?.match ?? null;
    const number = clip(matched?.invoice_number ?? detailMatch?.invoice_number ?? "", 60);
    const kind = ctx.duplicate?.kind ?? detailMatch?.kind ?? (steps.duplicate.severity === "reject" ? "hard" : "soft");
    if (kind === "hard") {
      return number === "" ? "Do not pay. Notify the vendor this invoice was already processed." : `Do not pay. Notify the vendor this invoice was already processed under ${number}.`;
    }
    return number === ""
      ? "Do not pay yet. Check with the vendor whether this repeats an earlier invoice."
      : `Do not pay yet. Check with the vendor whether this repeats ${number} before any payment.`;
  }

  const vendorStep = steps.vendor;
  const vendorFailed = vendorStep?.status === "fail";
  const bankProblem = vendorFailed && vendorStep.severity !== "reject" && ctx.vendor?.bankMismatch === true;
  // vendor not found / not approved
  if (vendorFailed && vendorStep.severity === "reject") return "Route vendor to onboarding before this can be processed.";
  // bank
  if (bankProblem) {
    const phone = ctx.vendor?.vendor?.phone_on_file;
    return blank(phone)
      ? "Verify the new bank details with the vendor, using a number from procurement records (none is on file), before any payment."
      : `Call the vendor on ${(phone as string).trim()} to verify new bank details before any payment.`;
  }
  // extraction failed / low confidence (also an unreadable or ambiguous vendor name). A validate failure counts only
  // when one of its problems is about reading the document: a future date or the vendor's own arithmetic is not
  // fixed by re-keying and falls through to the PO / amounts advice or the fallback (red team RT-RULES-07).
  // A non-invoice document routes by its type even when its vendor could not be resolved (CONTRACTS 4.3 #8, DRILL-1).
  const documentType = ctx.extraction?.document_type ?? "invoice";
  if (steps.extract?.status === "error" && (steps.extract.detail as { failure_kind?: unknown } | undefined)?.failure_kind === "billing_auth") {
    // nothing was read because the AI reading service was unavailable: a re-run works once it is back (DRILL-2)
    return "Re-run this invoice once the AI reading service is available again, or enter it manually.";
  }
  if (
    steps.extract?.status === "error" ||
    (steps.validate?.status === "fail" && documentType === "invoice" && needsManualEntry(steps.validate)) ||
    (vendorFailed && documentType === "invoice")
  ) {
    return "Manual data entry required.";
  }
  // document type
  if (steps.validate?.status === "fail" && documentType !== "invoice") {
    if (documentType === "credit_note") return "Route to credit process.";
    if (documentType === "statement") return "Route to statement handling.";
    return "Route to document handling.";
  }
  // PO
  if (needsAttention(steps.po_match)) {
    if (ctx.poMatch?.inferred === true && ctx.poMatch.po !== null) return `AP lead to confirm ${ctx.poMatch.po.po_number} is the correct PO.`;
    if ((steps.po_match.detail as { problem?: unknown } | undefined)?.problem === "currency") {
      return "Ask the vendor to reissue the invoice in the PO's currency, or the buyer to confirm the currency, before this can be processed.";
    }
    return "Ask the buyer or vendor for the correct PO number before this can be processed.";
  }
  // amounts
  if (needsAttention(steps.amounts)) {
    const detail = steps.amounts.detail as
      | {
          over_by?: unknown;
          within_tolerance?: unknown;
          price_within_tolerance?: unknown;
          unmatched_within_tolerance?: unknown;
          line_totals_within_tolerance?: unknown;
          tax_inclusive?: unknown;
        }
      | undefined;
    const overBy = ctx.amounts?.overBy ?? detail?.over_by ?? null;
    // Over the remaining balance beyond the tolerance, or only a unit price above the PO's, or lines not on the PO,
    // or more units / value on a PO line than it orders (DEC-1).
    if (finite(overBy) && overBy > 0 && detail?.within_tolerance !== true) {
      return `Ask the buyer for a PO amendment or the vendor for a credit of ${money(overBy)}.`;
    }
    const priceFailed = detail?.price_within_tolerance === false;
    const unmatchedFailed = detail?.unmatched_within_tolerance === false;
    const totalsFailed = detail?.line_totals_within_tolerance === false;
    if (detail?.within_tolerance === true && !priceFailed && (unmatchedFailed || totalsFailed)) {
      if (!totalsFailed) return "Ask the buyer whether the items that are not on the PO were ordered (PO amendment), or the vendor for a corrected invoice.";
      if (!unmatchedFailed) return "Ask the buyer whether the extra units or items billed against the PO lines were ordered (PO amendment), or the vendor for a corrected invoice.";
      return "Ask the buyer whether the extra units and the items that are not on the PO were ordered (PO amendment), or the vendor for a corrected invoice.";
    }
    if (detail?.within_tolerance === true && priceFailed && detail.tax_inclusive === true) {
      // the prices include tax and the PO is pre-tax: the difference may be only the tax (DEC-5)
      return "Check the pre-tax prices: the invoice prices include tax and the PO is pre-tax. Ask the vendor for an invoice with prices before tax, or the buyer for a PO amendment if the higher price is agreed.";
    }
    if (detail?.within_tolerance === true && totalsFailed) {
      return "Ask the vendor for a corrected invoice, or the buyer for a PO amendment if the higher unit price and the extra units are agreed.";
    }
    return detail?.within_tolerance === true
      ? "Ask the vendor for a corrected invoice, or the buyer for a PO amendment if the higher unit price is agreed."
      : "Ask the buyer for a PO amendment or the vendor for a credit.";
  }
  // ingest (stages 2-9 are skipped after a failed ingest, so nothing above applies)
  if (steps.ingest?.status === "fail") {
    const code = (steps.ingest.detail as { code?: unknown } | undefined)?.code;
    if (code === "encrypted") return "Request an unlocked copy of the PDF from the sender.";
    if (typeof (steps.ingest.detail as { run_id?: unknown } | undefined)?.run_id === "string") return "Do not process this file again; the same file was already handled.";
    return "Ask the sender for a valid, readable PDF.";
  }
  return "Review the reasons above.";
}
