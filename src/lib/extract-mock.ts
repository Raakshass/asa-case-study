/**
 * Offline mock extractor (ASSUMPTIONS.md: no API key during the build). Truth-JSON driven: sha256 of the
 * PDF bytes is looked up among data/samples/*.pdf (samples.ts loadTruthSamples, hashes indexed once and
 * rebuilt on a miss), so an upload of a copy of a sample also works. Never the default: only when EXTRACT_MOCK
 * is set (config.ts ENV.extractMock), and every result says model = MOCK_MODEL ("mock") with costUsd 0.
 *
 * OWNER: Phase 2. Must not import extract.ts (which imports this file). Keep every exported signature
 * (docs/CONTRACTS.md). The behaviour for unknown files and for EXTRACT_MOCK=fooled differs from the first
 * JSDoc of the contracts step; both are logged in docs/CONTRACT_CHANGES.md and ASSUMPTIONS.md.
 */
import fs from "node:fs";
import { CONFIG, ENV } from "./config";
import { sha256 } from "./pdf";
import { loadTruthSamples, type TruthMeta, type TruthSample } from "./samples";
import {
  CONFIDENCE_FIELDS,
  MOCK_MODEL,
  NO_SIGNALS,
  type ExtractAttempt,
  type ExtractOptions,
  type ExtractResult,
  type InvoiceExtraction,
  type SuggestPoInput,
  type SuggestPoResult,
} from "./types";

/* ================================================================================================
 * Sample index (sha256 of the PDF bytes -> truth sample)
 * ============================================================================================== */

let index: Map<string, TruthSample> | null = null;

function buildIndex(): Map<string, TruthSample> {
  const next = new Map<string, TruthSample>();
  for (const sample of loadTruthSamples()) {
    if (!sample.pdfExists) continue;
    try {
      next.set(sha256(fs.readFileSync(sample.pdfPath)), sample);
    } catch {
      // an unreadable PDF simply cannot be recognised
    }
  }
  return next;
}

function findSample(hash: string): TruthSample | null {
  const known = index?.get(hash);
  if (known) return known;
  // Rebuild on a miss: the PDFs may have been (re)generated since the index was built (dev server, Phase 1).
  index = buildIndex();
  return index.get(hash) ?? null;
}

/** Forgets the index (tests that switch the sample directory). */
export function resetMockIndex(): void {
  index = null;
}

/* ================================================================================================
 * Result building
 * ============================================================================================== */

/** First 24 bits of a sha256 hex string as a number: a stable pseudo-random value for simulated timings. */
function hashNumber(hex: string): number {
  return Number.parseInt(hex.slice(0, 6), 16);
}

/** Simulated, not measured: 600-1399 ms, the same for the same file. */
function simulatedLatencyMs(hash: string): number {
  return 600 + (hashNumber(hash) % 800);
}

function mockAttempt(latencyMs: number): ExtractAttempt {
  return {
    model: MOCK_MODEL,
    servedBy: MOCK_MODEL,
    ok: true,
    failure: null,
    httpStatus: null,
    finishReason: "stop",
    latencyMs,
    costUsd: 0,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    message: null,
  };
}

/** What the mock returns for bytes that are not one of the generated samples: a clean "not an invoice, unsure". */
function unknownDocument(): InvoiceExtraction {
  return {
    document_type: "other",
    vendor_name: null,
    invoice_number: null,
    invoice_date: null,
    due_date: null,
    po_reference: null,
    currency: null,
    line_items: [],
    subtotal: null,
    tax: null,
    total: null,
    tax_inclusive: false,
    bank_account: null,
    confidence: { vendor_name: 0.1, invoice_number: 0.1, invoice_date: 0.1, po_reference: 0.1, total: 0.1 },
    suspicious_content: [],
    notes: "Mock extractor: this file is not one of the generated samples, so nothing was extracted.",
    document_signals: { ...NO_SIGNALS },
  };
}

/**
 * A model that obeyed the hidden sentence: it reports the injected values and sets every confidence to 1.0.
 * suspicious_content is left as in the truth (the model still quotes the sentence), so the run shows how the
 * injection screen, the grounding check and the rules each react to values the document does not contain.
 */
function applyInjection(data: InvoiceExtraction, injected: NonNullable<TruthMeta["injectedValues"]>): void {
  if (injected.po_reference !== undefined) data.po_reference = injected.po_reference;
  if (injected.total !== undefined) data.total = injected.total;
  for (const field of CONFIDENCE_FIELDS) data.confidence[field] = 1;
}

/**
 * ExtractFn. Known sample -> { ok: true, data: truth extraction (no _meta), rawOutput: JSON.stringify(data),
 * model: "mock", costUsd: 0, attempts: [one ok attempt] }, latencyMs simulated (600-1399 ms, stable per file).
 * ENV.extractMock === "fooled": a sample with _meta.injectedValues (#9) also gets those values applied and every
 * confidence set to 1.0 (a fooled model); suspicious_content is kept. The screen and grounding must still stop it.
 * Bytes that are not a generated sample -> ok: true with a clean { document_type: "other" } result, every
 * confidence 0.1 and a note saying so (the pipeline then HOLDs it as "not an invoice"). { ok: false, kind:
 * "unreadable" } only when the truth data itself cannot be loaded. Never throws.
 */
export async function mockExtractInvoice(pdf: Uint8Array, opts?: ExtractOptions): Promise<ExtractResult> {
  void opts; // the mock has no models, engines or image-only handling
  try {
    const hash = sha256(pdf);
    const sample = findSample(hash);
    const latencyMs = simulatedLatencyMs(hash);
    const data = sample ? structuredClone(sample.extraction) : unknownDocument();
    if (sample && ENV.extractMock === "fooled" && sample.meta.injectedValues !== null) {
      applyInjection(data, sample.meta.injectedValues);
    }
    return {
      ok: true,
      data,
      rawOutput: JSON.stringify(data),
      model: MOCK_MODEL,
      costUsd: 0,
      latencyMs,
      attempts: [mockAttempt(latencyMs)],
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 300) : "unexpected error";
    return {
      ok: false,
      kind: "unreadable",
      message: `Mock extractor: ${reason}`,
      model: MOCK_MODEL,
      costUsd: 0,
      latencyMs: 0,
      attempts: [],
    };
  }
}

/* ================================================================================================
 * mockSuggestPO
 * ============================================================================================== */

const MIN_WORD_CHARS = 3;

/** Lower-case words of 3+ characters with a trailing plural "s" removed ("visits" and "visit" match). */
function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.normalize("NFKC").toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < MIN_WORD_CHARS) continue;
    out.add(word.length > MIN_WORD_CHARS && word.endsWith("s") ? word.slice(0, -1) : word);
  }
  return out;
}

/**
 * SuggestPoFn. Deterministic: scores each candidate by the number of words its line descriptions share with the
 * invoice line descriptions, plus one point per invoice unit price that equals a PO line unit price. A candidate
 * with no shared word is out. Highest score wins; "NONE" when nothing overlaps or two candidates tie.
 * model "mock", costUsd 0. Picks PO-1005 for sample #5 ("HVAC maintenance - 2 visits" @ 750). Never throws.
 */
export async function mockSuggestPO(input: SuggestPoInput): Promise<SuggestPoResult> {
  try {
    const invoiceWords = stems(input.lineItems.map((l) => l.description).join(" "));
    const invoicePrices = input.lineItems.map((l) => l.unit_price).filter((p): p is number => p !== null);
    const seen = new Set<string>();
    const scored: { po: string; score: number; words: string[]; priceHits: number }[] = [];
    for (const candidate of input.candidates) {
      if (seen.has(candidate.po_number)) continue;
      seen.add(candidate.po_number);
      const poWords = stems(candidate.lines.map((l) => l.description).join(" "));
      const words = [...invoiceWords].filter((w) => poWords.has(w)).sort();
      const priceHits = invoicePrices.filter((p) => candidate.lines.some((l) => Math.abs(l.unit_price - p) < 0.005)).length;
      scored.push({ po: candidate.po_number, score: words.length === 0 ? -1 : words.length + priceHits, words, priceHits });
    }
    const best = scored.reduce((top, s) => Math.max(top, s.score), -1);
    const winners = scored.filter((s) => s.score === best && best > 0);
    const seed = sha256(new TextEncoder().encode(`${[...invoiceWords].sort().join(" ")}|${[...seen].sort().join(",")}`));
    const latencyMs = 120 + (hashNumber(seed) % 280);

    const none = (reasoning: string): SuggestPoResult => ({
      ok: true,
      po_number: "NONE",
      confidence: 0.2,
      reasoning,
      model: MOCK_MODEL,
      costUsd: 0,
      latencyMs,
    });
    if (winners.length === 0) return none("Mock matcher: no candidate purchase order shares a word with the invoice lines.");
    if (winners.length > 1) return none("Mock matcher: more than one candidate fits equally well, so none was chosen.");
    const [win] = winners;
    const prices = win.priceHits > 0 ? ` and ${win.priceHits} unit price(s) match` : "";
    return {
      ok: true,
      po_number: win.po,
      confidence: Math.min(0.95, Math.round((0.5 + 0.1 * win.score) * 100) / 100),
      reasoning: `Mock matcher: the invoice lines share the words ${win.words.slice(0, 5).join(", ")} with ${win.po}${prices}.`.slice(
        0,
        CONFIG.suggestPoReasoningMaxChars,
      ),
      model: MOCK_MODEL,
      costUsd: 0,
      latencyMs,
    };
  } catch {
    return { ok: false, kind: "failed", message: "Mock matcher: unexpected error", costUsd: 0, latencyMs: 0 };
  }
}
