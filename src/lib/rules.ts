/**
 * Every business check, decide() and nextAction() (IMPLEMENTATION_PLAN.md section 7). PURE: no fs, db,
 * network or clock. Inputs are the extraction, its normalization, a master-data Snapshot (master.ts) and
 * an explicit `now`; suggestPO is injected (SuggestPoFn) so scripts/check.ts runs with no LLM.
 * Every check returns a StepResult (types.ts) whose reason is plain sentences.
 *
 * OWNER: Phase 3. Stubs below throw NOT_IMPLEMENTED; keep every exported signature (docs/CONTRACTS.md).
 * Reason phrases that scripts/check.ts asserts (via truth _meta) are listed in docs/CONTRACTS.md 3.3.
 */
import type { Snapshot } from "./master";
import type {
  AmountsOutcome,
  DecideResult,
  Decision,
  DecisionContext,
  DuplicateOutcome,
  ExtractResult,
  GroundingResult,
  InvoiceExtraction,
  NormalizedInvoice,
  PoMatchOutcome,
  StepMap,
  StepResult,
  SuggestPoFn,
  UploadValidation,
  Vendor,
  VendorOutcome,
} from "./types";

export type { SuggestPoFn };

function notImplemented(what: string, ...args: unknown[]): never {
  void args;
  throw new Error(`NOT_IMPLEMENTED: ${what}`);
}

/**
 * Stage 1. upload not ok -> fail with severity upload.outcome and upload.reason. A non-errored invoices
 * row with the same file_hash -> fail/reject "Exact same file already processed in run <run_id>"
 * (rows whose run had a system error do not count, so a re-run after an outage is possible). Else pass.
 */
export function checkIngest(upload: UploadValidation, fileHash: string, snapshot: Snapshot): StepResult {
  return notImplemented("rules.checkIngest", upload, fileHash, snapshot);
}

/**
 * Stage 3. !ok -> status "error": billing_auth -> "LLM provider unavailable (billing/auth)", unreadable ->
 * "Could not read invoice, manual entry required". ok with non-empty suspicious_content -> fail/hold with
 * a reason containing "suspicious" that quotes the content. Else pass. detail: ExtractDetail.
 */
export function checkExtract(result: ExtractResult): StepResult {
  return notImplemented("rules.checkExtract", result);
}

/**
 * Stage 4: lists EVERY problem. HOLD problems: document_type not "invoice" (credit note -> "route to credit
 * process"; statement/receipt/other -> reason containing "not an invoice"), missing vendor/invoice number/
 * date/total, confidence < CONFIG.minFieldConfidence on a critical field that has a value, line sum vs
 * subtotal and subtotal + tax vs total (tax add skipped when tax_inclusive) beyond CONFIG.arithmeticTolerance,
 * grounding.misses, invoice date in the future or older than CONFIG.maxInvoiceAgeDays (relative to `now`).
 * Info warnings: due date before invoice date; grounding === null -> "No text layer to verify against (scanned)".
 * Any HOLD problem -> fail/hold; else any warning -> warn/info; else pass. detail: ValidateDetail.
 */
export function checkValidate(extraction: InvoiceExtraction, grounding: GroundingResult | null, now: Date): StepResult {
  return notImplemented("rules.checkValidate", extraction, grounding, now);
}

/** Stage 5: always pass (plan: no fail/warn); reason summarises the normalized number, date and vendor match. detail: the NormalizedInvoice. */
export function checkNormalize(normalized: NormalizedInvoice): StepResult {
  return notImplemented("rules.checkNormalize", normalized);
}

/**
 * Stage 6. Vendor from normalized.vendor_id. Not found / not approved -> fail/reject with a reason containing
 * "onboarding". Invoice bank (normId) != bank on file -> fail/hold, reason exactly: "Bank details differ from
 * vendor master; call <phone_on_file> (number on file) to verify. Do not use contact details from the invoice."
 * Else pass. Bank details are only ever taken from the master; the invoice value is only compared.
 */
export function checkVendor(extraction: InvoiceExtraction, normalized: NormalizedInvoice, snapshot: Snapshot): VendorOutcome {
  return notImplemented("rules.checkVendor", extraction, normalized, snapshot);
}

/**
 * Stage 7. PO printed -> must exist (normId match), belong to the vendor and be open, else fail/hold.
 * No PO -> candidates = the vendor's open POs with remainingBalance >= the invoice subtotal: 0 -> fail/hold;
 * 1 -> warn/hold "PO inferred as PO-xxxx ..., needs confirmation"; > 1 -> suggestPo({ lineItems, candidates });
 * re-check its po_number is a candidate (else treat as "NONE" -> fail/hold); a pick -> warn/hold
 * "PO inferred as PO-1005 (confidence 0.86), needs confirmation" with the reasoning in detail.
 * Invoice currency (null = USD) != PO currency -> fail/hold. detail: PoMatchDetail.
 */
export async function checkPoMatch(
  extraction: InvoiceExtraction,
  normalized: NormalizedInvoice,
  vendor: Vendor | null,
  snapshot: Snapshot,
  suggestPo: SuggestPoFn,
): Promise<PoMatchOutcome> {
  return notImplemented("rules.checkPoMatch", extraction, normalized, vendor, snapshot, suggestPo);
}

/**
 * Stage 8. No PO -> skipped. Subtotal vs remainingBalance(po, snapshot.invoices): over by <= CONFIG.priceTolerancePct
 * of the remaining -> warn/info with a reason containing "tolerance"; more -> fail/hold, e.g. "Exceeds remaining
 * PO balance by $3,000.00. PO-1003: $30,000.00 total, $24,000.00 already approved (GLX-301, GLX-302), $6,000.00
 * remaining." Per-line unit price vs the PO line with the matching description: > 2% over -> warn/info.
 * Amounts via format.ts formatUsd. detail: AmountsDetail.
 */
export function checkAmounts(
  extraction: InvoiceExtraction,
  normalized: NormalizedInvoice,
  poMatch: PoMatchOutcome,
  snapshot: Snapshot,
): AmountsOutcome {
  return notImplemented("rules.checkAmounts", extraction, normalized, poMatch, snapshot);
}

/**
 * Stage 9, against the vendor's earlier invoices (recommended: decision APPROVE or HOLD, run_had_error false).
 * Hard: same invoice_number_norm -> fail/reject "Duplicate of INV-0042 (processed 2026-10-05); numbers differ
 * only in formatting". Soft: same subtotal, invoice dates within CONFIG.softDuplicateWindowDays, different
 * number -> fail/hold. Same amount further apart -> pass with a reason containing "recurring pattern, not a
 * duplicate". detail: DuplicateDetail.
 */
export function checkDuplicate(
  extraction: InvoiceExtraction,
  normalized: NormalizedInvoice,
  vendor: Vendor | null,
  snapshot: Snapshot,
): DuplicateOutcome {
  return notImplemented("rules.checkDuplicate", extraction, normalized, vendor, snapshot);
}

/**
 * Stage 10 (plan section 7 precedence; severity drives it, status is presentation):
 * 1. any fail with severity "reject" -> REJECT
 * 2. any fail or warn with severity "hold" (a fail without severity counts as hold) -> HOLD
 * 3. any step "error" -> HOLD (its reason, e.g. "System error at PO match, manual review")
 * 4. otherwise APPROVE (warnings become notes)
 * reasons = every fail + warn + error reason, decisive first (reject, then hold/error, then info), stage
 * order within each group. securityFlag = steps.screen failed OR ctx.extraction.suspicious_content non-empty;
 * MUST force HOLD when the precedence alone would APPROVE (invariant: securityFlag => never APPROVE).
 */
export function decide(steps: StepMap, ctx: DecisionContext): DecideResult {
  return notImplemented("rules.decide", steps, ctx);
}

/**
 * Decision card next action (plan section 7 table), from the first problem in this priority:
 * security -> duplicate -> vendor -> bank -> extraction -> document type -> PO -> amounts; APPROVE ->
 * "Queue for payment on due date <due_date, else invoice_date + CONFIG.paymentTermsDays>." For a
 * non-invoice document_type, route by document type even if fields are missing.
 * Fallback: "Review the reasons above."
 */
export function nextAction(decision: Decision, steps: StepMap, ctx: DecisionContext): string {
  return notImplemented("rules.nextAction", decision, steps, ctx);
}
