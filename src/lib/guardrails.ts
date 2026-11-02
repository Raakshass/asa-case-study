/**
 * Deterministic guardrails (IMPLEMENTATION_PLAN.md section 6.2 and 6.4, docs/notes-unpdf.md):
 * the stage-2 security screen (injection pattern scan + hidden/tiny text) and the stage-4 grounding
 * check (extracted values must appear as visible tokens). Pure functions of their inputs.
 *
 * OWNER: Phase 4. Stubs below throw NOT_IMPLEMENTED; keep every exported signature (docs/CONTRACTS.md).
 * The tested reference code for isImageOnly / findTinyText / buildGroundingText is in docs/notes-unpdf.md.
 */
import type { GroundingResult, InvoiceExtraction, ScreenResult, StepResult, TextItem } from "./types";

function notImplemented(what: string, ...args: unknown[]): never {
  void args;
  throw new Error(`NOT_IMPLEMENTED: ${what}`);
}

/** Joined text layer: items.map(i => i.str).join("") (equals unpdf extractText per page, pages in order). */
export function joinText(items: readonly TextItem[]): string {
  return notImplemented("guardrails.joinText", items);
}

/** Fewer than CONFIG.imageOnlyMaxChars (20) NON-whitespace characters across all pages. */
export function isImageOnly(items: readonly TextItem[]): boolean {
  return notImplemented("guardrails.isImageOnly", items);
}

/**
 * Injection pattern scan on JOINED text (never per item), after NFKC and collapsing whitespace to single
 * spaces. Returns one quoted snippet per hit (the match plus a little context, at most 200 characters),
 * deduplicated, in document order. Default patterns: CONFIG.injectionPatterns.
 */
export function scanInjection(text: string, patterns?: readonly RegExp[]): string[] {
  return notImplemented("guardrails.scanInjection", text, patterns);
}

/**
 * Runs of CONSECUTIVE items per page with height < maxPt (default CONFIG.tinyTextMaxPt = 3), whitespace-only
 * items neither starting nor breaking a run, kept when the run has >= minWords (default 4) words.
 * Returns each run's text, whitespace collapsed. Catches #9 (Chromium renders CSS 1px as 0.75pt, split at
 * the "fi" ligature into 3 items). Does NOT catch white text at normal size (no colour in getTextContent).
 */
export function findTinyText(items: readonly TextItem[], maxPt?: number, minWords?: number): string[] {
  return notImplemented("guardrails.findTinyText", items, maxPt, minWords);
}

/** Stage 2: { isImageOnly, textChars, injectionHits: scanInjection(joinText), hiddenText: findTinyText }. */
export function screenPdf(items: readonly TextItem[]): ScreenResult {
  return notImplemented("guardrails.screenPdf", items);
}

/**
 * Stage 2 step result. Any injection hit or hidden text -> { status: "fail", severity: "hold" } with a
 * reason containing "Suspicious" for injection hits and "Tiny or hidden text found: '...'" for hidden text
 * (both sentences when both fire). Otherwise "pass" (reason notes "image-only, no text layer" when
 * isImageOnly). detail = the ScreenResult.
 */
export function checkScreen(screen: ScreenResult): StepResult {
  return notImplemented("guardrails.checkScreen", screen);
}

/**
 * Grounding text (plan 6.4 as corrected): join str of every item, replacing EVERY item with height < maxPt
 * (default 3) by " ", so tiny/injected text can never ground the values it injects.
 */
export function buildGroundingText(items: readonly TextItem[], maxPt?: number): string {
  return notImplemented("guardrails.buildGroundingText", items, maxPt);
}

/** Whitespace tokens of a text (empty tokens dropped). */
export function tokenize(text: string): string[] {
  return notImplemented("guardrails.tokenize", text);
}

/**
 * Stage 4 grounding (plan 6.4): invoice_number, po_reference (when not null) and total must each match a
 * WHOLE visible token. Identifiers: normId(token) === normId(value) (format.ts). Amounts: strip "$" and ","
 * (and trailing punctuation) from each token, parse, compare within CONFIG.groundingAmountTolerance, so 400
 * never matches "4,400.00". `visible` is grounding text (string) or its tokens.
 * Miss reason format: "Extracted total 400.00 does not appear in the document; possible manipulation or misread".
 * Callers pass null instead of calling this for image-only PDFs.
 */
export function groundExtraction(extraction: InvoiceExtraction, visible: string | readonly string[]): GroundingResult {
  return notImplemented("guardrails.groundExtraction", extraction, visible);
}
