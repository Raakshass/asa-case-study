/**
 * Offline mock extractor (ASSUMPTIONS.md: no API key during the build). Truth-JSON driven: sha256 of the
 * PDF bytes is looked up among data/samples/*.pdf (samples.ts loadTruthSamples, hashes cached once), so
 * an upload of a copy of a sample also works. Never the default: only when EXTRACT_MOCK is set
 * (config.ts ENV.extractMock), and every result says model = MOCK_MODEL ("mock") with costUsd 0.
 *
 * OWNER: Phase 2. Stubs below throw NOT_IMPLEMENTED; keep every exported signature (docs/CONTRACTS.md).
 */
import type { ExtractOptions, ExtractResult, SuggestPoInput, SuggestPoResult } from "./types";

function notImplemented(what: string, ...args: unknown[]): never {
  void args;
  throw new Error(`NOT_IMPLEMENTED: ${what}`);
}

/**
 * ExtractFn. Known sample -> { ok: true, data: truth extraction (no _meta), rawOutput: JSON.stringify(data),
 * model: "mock", costUsd: 0, attempts: [one ok attempt] }. ENV.extractMock === "fooled": also applies
 * _meta.injectedValues, clears suspicious_content and sets every confidence to 1.0 (a fully fooled model;
 * the screen and grounding must still stop it). Unknown bytes -> { ok: false, kind: "unreadable",
 * message: "Mock extractor: not one of the generated samples" }. Never throws.
 */
export async function mockExtractInvoice(pdf: Uint8Array, opts?: ExtractOptions): Promise<ExtractResult> {
  return notImplemented("extract-mock.mockExtractInvoice", pdf, opts);
}

/**
 * SuggestPoFn. Deterministic: scores each candidate by word overlap between the invoice line descriptions
 * and the PO line descriptions (+ unit price equality), picks the best, "NONE" on a tie or zero overlap;
 * model "mock", costUsd 0. Must pick PO-1005 for sample #5 ("HVAC maintenance - 2 visits" @ 750).
 */
export async function mockSuggestPO(input: SuggestPoInput): Promise<SuggestPoResult> {
  return notImplemented("extract-mock.mockSuggestPO", input);
}
