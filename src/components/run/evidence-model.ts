/**
 * Words for the evidence of a stage (owner: UI-RUN): humane labels for the keys the pipeline writes into
 * `run_steps.detail`, plain-language names for its codes, and which keys are money, percentages, durations and
 * so on. Pure data and tiny functions; the generic fallback (a key nobody listed) turns "some_key" into "Some key".
 * Client-safe: imports only types.ts (and the sibling helpers).
 */
import type { StageKey } from "@/lib/types";
import { displayText } from "./run-format";

/** Humane label of a detail key. A stage can word a key differently (see STAGE_LABELS below). */
const LABELS: Record<string, string> = {
  // ingest
  size_bytes: "File size",
  page_count: "Pages",
  file_hash: "File fingerprint (SHA-256)",
  code: "Why it failed",
  run_id: "Earlier run",
  invoice_number: "Invoice number",
  decision: "Decision",
  // screen
  isImageOnly: "Image only (no text layer)",
  textChars: "Characters of text read",
  injectionHits: "Instruction-like text found",
  hiddenText: "Hidden (tiny) text found",
  // extract
  model: "Model",
  latency_ms: "Model time",
  cost_usd: "Cost",
  attempts: "Attempts",
  suspicious_content: "Reported by the model as suspicious",
  servedBy: "Served by",
  ok: "Succeeded",
  failure: "Failure",
  httpStatus: "HTTP status",
  finishReason: "Finish reason",
  latencyMs: "Time",
  costUsd: "Cost",
  promptTokens: "Prompt tokens",
  completionTokens: "Completion tokens",
  reasoningTokens: "Reasoning tokens",
  message: "Message",
  // validate
  problems: "Problems",
  warnings: "Warnings",
  grounding: "Grounding",
  fields: "Fields",
  misses: "Not found in the document",
  field_problems: "Problems by field",
  problem_kinds: "Kinds of problem",
  document_type: "Document type",
  line_sum: "Sum of the line items",
  expected_total: "Total the document should show",
  pretax_amount: "Pre-tax amount",
  today: "Date used as today",
  field: "Field",
  value: "Value",
  status: "Result",
  matchedToken: "Found in the document as",
  // normalize
  vendor_name: "Vendor name (as printed)",
  vendor_name_norm: "Vendor name (normalized)",
  vendor_id: "Vendor ID",
  invoice_number_norm: "Invoice number (normalized)",
  invoice_date: "Invoice date",
  due_date: "Due date",
  po_reference: "PO reference (as printed)",
  po_reference_norm: "PO reference (normalized)",
  currency: "Currency",
  bank_account_norm: "Bank account (normalized)",
  // vendor
  approved: "Approved vendor",
  bank_mismatch: "Bank account differs from the vendor master",
  invoice_bank: "Bank account on the invoice",
  master_bank: "Bank account on file",
  phone_on_file: "Phone number on file",
  ambiguous_vendor_ids: "Vendors with a matching name",
  // po_match
  po_number: "PO number",
  inferred: "PO inferred (not printed on the invoice)",
  candidates: "Candidate POs",
  confidence: "Confidence",
  reasoning: "Reasoning",
  printed_po: "PO printed on the invoice",
  problem: "Problem",
  amount: "Invoice amount",
  found_po: "PO found",
  suggested_po: "PO suggested",
  suggestion_failure: "Why no suggestion",
  // amounts
  po_subtotal: "PO total",
  already_approved: "Already approved",
  approved_invoices: "Approved invoices",
  remaining: "Remaining on the PO",
  invoice_subtotal: "Invoice amount",
  over_by: "Over by",
  over_pct: "Over the remaining balance by",
  approved_invoice_count: "Number of approved invoices",
  amount_source: "Amount compared with the PO",
  tolerance_pct: "Tolerance",
  within_tolerance: "Within the tolerance",
  price_within_tolerance: "Unit prices within the tolerance",
  unmatched_within_tolerance: "Lines not on the PO within the tolerance",
  tax_inclusive: "Amounts include tax",
  lines: "Unit prices against the PO",
  unmatched_lines: "Lines that are not on the PO",
  unmatched_total: "Total of the lines not on the PO",
  description: "Description",
  po_description: "PO line",
  invoice_unit_price: "Invoice unit price",
  po_unit_price: "PO unit price",
  price_source: "Price taken from",
  quantity: "Quantity",
  unit_price: "Unit price",
  // duplicate
  match: "Matched earlier invoice",
  recurring: "Recurring pattern",
  kind: "Kind",
  days_apart: "Days apart",
  window_days: "Duplicate window (days)",
  original_decision: "Decision on the earlier invoice",
  // decide
  reasons: "Reasons",
  next_action: "Next action",
  security_flag: "Security flag",
};

/** Keys a stage words differently from the default above. */
const STAGE_LABELS: Partial<Record<StageKey, Record<string, string>>> = {
  ingest: { invoice_number: "Invoice number of the earlier run", decision: "Decision of the earlier run" },
  vendor: { vendor_name: "Vendor in the vendor master" },
  po_match: { amount: "Invoice amount used to choose candidate POs" },
  decide: { decision: "Decision" },
};

/** "someKey" / "some_key" -> "Some key": the fallback for a key nobody has a label for. */
export function humanizeKey(key: string): string {
  const spaced = displayText(key, 60)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced === "" ? "Value" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A value of `table` only when `key` is its OWN key: a key such as "constructor" or "__proto__" must never reach Object.prototype. */
function own<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

export function labelFor(stage: StageKey | null, key: string): string {
  return own(stage ? own(STAGE_LABELS, stage) : undefined, key) ?? own(LABELS, key) ?? humanizeKey(key);
}

/** How a number under this key is written. */
export type ValueKind = "money" | "precise-money" | "percent" | "confidence" | "duration" | "bytes" | "cost" | "count" | "hash";

const KINDS: Record<string, ValueKind> = {
  po_subtotal: "money",
  already_approved: "money",
  remaining: "money",
  invoice_subtotal: "money",
  over_by: "money",
  amount: "money",
  unmatched_total: "money",
  line_sum: "money",
  expected_total: "money",
  pretax_amount: "money",
  subtotal: "money",
  tax: "money",
  total: "money",
  invoice_unit_price: "precise-money",
  po_unit_price: "precise-money",
  unit_price: "precise-money",
  over_pct: "percent",
  tolerance_pct: "percent",
  confidence: "confidence",
  latency_ms: "duration",
  latencyMs: "duration",
  size_bytes: "bytes",
  cost_usd: "cost",
  costUsd: "cost",
  textChars: "count",
  page_count: "count",
  approved_invoice_count: "count",
  days_apart: "count",
  window_days: "count",
  promptTokens: "count",
  completionTokens: "count",
  reasoningTokens: "count",
  file_hash: "hash",
};

export function kindOf(key: string): ValueKind | null {
  return own(KINDS, key) ?? null;
}

/** Plain-language names for the codes the stages write (a value nobody listed is shown as it is). */
const WORDS: Record<string, Record<string, string>> = {
  code: {
    empty: "The file is empty",
    not_pdf: "The file is not a PDF",
    too_large: "The file is too large",
    too_many_pages: "The PDF has too many pages",
    encrypted: "The PDF is password-protected",
    damaged: "The PDF is damaged or unreadable",
  },
  problem: {
    not_found: "The PO is not in the purchase order master",
    wrong_vendor: "The PO belongs to a different vendor",
    not_open: "The PO is not open",
    currency: "The invoice currency does not match the PO",
    no_amount: "No invoice amount could be read",
    no_candidates: "No open PO of this vendor has enough balance left",
    suggestion_failed: "The PO suggestion was unavailable",
    no_clear_match: "None of the candidate POs was a clear match",
    inferred: "No PO is printed on the invoice, so one was inferred",
  },
  kind: {
    hard: "Hard duplicate (same invoice number once formatting is ignored)",
    soft: "Possible duplicate (same vendor and amount, close in time, different number)",
  },
  price_source: { printed: "The printed unit price", "amount / quantity": "The line amount divided by the quantity" },
  amount_source: { subtotal: "The subtotal", "total (no subtotal printed)": "The total (no subtotal is printed)" },
  failure: {
    billing_auth: "Billing or authorization",
    rate_limited: "Rate limited",
    transient: "Temporary error",
    rejected: "Request rejected",
    refused: "The model refused",
    truncated: "Output was cut off",
    invalid_output: "Invalid output",
  },
  suggestion_failure: { billing_auth: "Billing or authorization", failed: "The suggestion failed" },
  problem_kinds: {
    extraction: "Reading the document",
    document_type: "Kind of document",
    arithmetic: "The document's own arithmetic",
    date: "A date out of range",
  },
  status: {
    grounded: "Found in the document",
    missing: "Not found in the document",
    not_applicable: "Nothing to check (no value)",
  },
  field: { invoice_number: "Invoice number", po_reference: "PO reference", total: "Total" },
  document_type: {
    invoice: "Invoice",
    credit_note: "Credit note",
    statement: "Statement of account",
    receipt: "Receipt",
    other: "Other document",
  },
};

/** The plain-language name of a code under `key`, or null when there is none. */
export function wordFor(key: string, value: string): string | null {
  return own(own(WORDS, key), value) ?? null;
}

/** How a yes/no value reads: whether Yes is good news, bad news or just a flag. null = no colour. */
export type Emphasis = "good" | "bad" | "warn" | "security";

export function boolEmphasis(key: string, value: boolean): Emphasis | null {
  switch (key) {
    case "approved":
    case "within_tolerance":
    case "price_within_tolerance":
    case "unmatched_within_tolerance":
    case "ok":
      return value ? "good" : "bad";
    case "bank_mismatch":
      return value ? "bad" : "good";
    case "inferred":
      return value ? "warn" : null;
    case "security_flag":
      return value ? "security" : null;
    default:
      return null;
  }
}
