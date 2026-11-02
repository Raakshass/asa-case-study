/**
 * The 10 generated sample invoices and their ground truth (data/samples/*.pdf + data/samples/truth/NN.json,
 * written by Phase 1 scripts/gen-invoices.ts). Read by scripts/check.ts, the mock extractor,
 * GET /api/samples, POST /api/runs {sample} and scripts/eval-extract.ts. Exact JSON shape:
 * docs/CONTRACTS.md section 3.2. Server-only. Owner: contracts step.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "./config";
import {
  DecisionSchema,
  type InvoiceExtraction,
  InvoiceExtractionSchema,
  RESULT_STATUSES,
  type SampleListItem,
  StageKeySchema,
  invoiceExtractionShape,
  refineInvoiceExtraction,
} from "./types";

/** The only sample names POST /api/runs accepts (plan section 3; no free paths). */
export const SAMPLE_FILES = [
  "01-happy-northwind.pdf",
  "02-within-tolerance.pdf",
  "03-split-po-overbill.pdf",
  "04-disguised-duplicate.pdf",
  "05-scanned-no-po.pdf",
  "06-bank-change.pdf",
  "07-recurring-not-duplicate.pdf",
  "08-unapproved-vendor.pdf",
  "09-prompt-injection.pdf",
  "10-not-an-invoice.pdf",
] as const;
export type SampleFile = (typeof SAMPLE_FILES)[number];
export const SampleFileSchema = z.enum(SAMPLE_FILES);

export function isSampleFile(name: string): name is SampleFile {
  return (SAMPLE_FILES as readonly string[]).includes(name);
}

/** `_meta` of a truth file. Every key is required (use null / [] when not applicable). */
export const TruthMetaSchema = z
  .strictObject({
    /** two digits, equals the file prefix and the truth file name (09 -> truth/09.json) */
    id: z.string().regex(/^\d{2}$/),
    file: SampleFileSchema,
    /** sample card title, e.g. "Prompt injection" */
    title: z.string().min(1).max(60),
    /** one line for the sample card */
    scenario: z.string().min(1).max(200),
    /** headline edge case letter from plan section 3 (A-E), else null */
    edgeCase: z.enum(["A", "B", "C", "D", "E"]).nullable(),
    expectedDecision: DecisionSchema,
    /** case-insensitive; each must occur in at least one of decide().reasons */
    expectedReasonIncludes: z.array(z.string().min(1).max(80)).max(5),
    /** case-insensitive substring of nextAction() */
    expectedNextActionIncludes: z.string().min(1).max(80),
    expectedSecurityFlag: z.boolean(),
    /** the PO stage 7 should end on (inferred = no PO printed), or null when no PO should match */
    expectedPo: z.strictObject({ po_number: z.string().regex(/^PO-\d{4,}$/), inferred: z.boolean() }).nullable(),
    /** per-stage expectations asserted by the business check (stages extract..duplicate only) */
    expectedSteps: z.partialRecord(
      StageKeySchema,
      z.strictObject({ status: z.enum(RESULT_STATUSES).optional(), reasonIncludes: z.string().min(1).max(80).optional() }),
    ),
    /** HTML template used by gen-invoices */
    layout: z.enum(["itemised", "services", "compact", "statement"]),
    /** scanned = image-only PDF with no text layer */
    render: z.enum(["text", "scanned"]),
    /** text rendered invisibly (white, CSS 1px) inside the printable page; #9 only */
    hiddenText: z.string().min(1).max(1000).nullable(),
    /** values the hidden text tries to force (#9: PO-1003 / 400); the "fooled" mock applies them */
    injectedValues: z.strictObject({ po_reference: z.string().optional(), total: z.number().optional() }).nullable(),
    /** vendor / PO / history setup notes for humans */
    setup: z.string().max(500),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string, key: string) => ctx.addIssue({ code: "custom", message, path: [key] });
    if (!m.file.startsWith(`${m.id}-`)) issue(`file must start with "${m.id}-"`, "file");
    if (m.render === "scanned" && m.hiddenText !== null) issue("a scanned sample has no text layer to hide text in", "hiddenText");
    if (m.injectedValues !== null && m.hiddenText === null) issue("injectedValues requires hiddenText", "injectedValues");
    if (m.expectedSecurityFlag && m.expectedDecision === "APPROVE") issue("a security-flagged sample can never be APPROVE", "expectedDecision");
  });
export type TruthMeta = z.infer<typeof TruthMetaSchema>;

/** data/samples/truth/NN.json = the InvoiceExtraction the model SHOULD return + `_meta`. */
export const TruthFileSchema = z
  .strictObject({ ...invoiceExtractionShape, _meta: TruthMetaSchema })
  .superRefine(refineInvoiceExtraction);

export interface TruthSample {
  id: string;
  file: SampleFile;
  meta: TruthMeta;
  /** the truth without _meta, validated by InvoiceExtractionSchema */
  extraction: InvoiceExtraction;
  truthPath: string;
  pdfPath: string;
  pdfExists: boolean;
}

export class TruthDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TruthDataError";
  }
}

/**
 * Loads every truth/NN.json, sorted by id. Returns [] when the truth directory does not exist yet;
 * throws TruthDataError (naming the file) when a file is invalid.
 */
export function loadTruthSamples(truthDir: string = paths.truthDir, samplesDir: string = paths.samplesDir): TruthSample[] {
  if (!fs.existsSync(truthDir)) return [];
  const files = fs
    .readdirSync(truthDir)
    .filter((f) => /^\d{2}\.json$/.test(f))
    .sort();
  return files.map((f) => {
    const truthPath = path.join(truthDir, f);
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(truthPath, "utf8"));
    } catch (e) {
      throw new TruthDataError(`${f} is not valid JSON: ${(e as Error).message}`);
    }
    const parsed = TruthFileSchema.safeParse(json);
    if (!parsed.success) throw new TruthDataError(`${f} does not match the contract:\n${z.prettifyError(parsed.error)}`);
    const { _meta: meta, ...rest } = parsed.data;
    if (`${meta.id}.json` !== f) throw new TruthDataError(`${f}: _meta.id is "${meta.id}"`);
    const extraction = InvoiceExtractionSchema.parse(rest);
    const pdfPath = path.join(samplesDir, meta.file);
    return { id: meta.id, file: meta.file, meta, extraction, truthPath, pdfPath, pdfExists: fs.existsSync(pdfPath) };
  });
}

/** GET /api/samples: one entry per truth file whose PDF exists, in id order. */
export function listSamples(truthDir?: string, samplesDir?: string): SampleListItem[] {
  return loadTruthSamples(truthDir, samplesDir)
    .filter((s) => s.pdfExists)
    .map((s) => ({
      file: s.file,
      title: s.meta.title,
      scenario: s.meta.scenario,
      expected: s.meta.expectedDecision,
      edge_case: s.meta.edgeCase,
    }));
}

/** Absolute path of a sample PDF (the name is typed, so callers must validate with SampleFileSchema first). */
export function samplePdfPath(file: SampleFile, samplesDir: string = paths.samplesDir): string {
  return path.join(samplesDir, file);
}
