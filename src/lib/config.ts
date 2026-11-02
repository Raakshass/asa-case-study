/**
 * Tolerances, thresholds, limits (IMPLEMENTATION_PLAN.md section 7) and every environment variable
 * reader except OPENROUTER_API_KEY, which only extract.ts reads (plan section 6, "Key leakage").
 * Server-only (imports node:path / node:fs): client components must not import this file.
 * Owner: contracts step (docs/CONTRACTS.md).
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Injection pattern scan (plan section 6.2). Case-insensitive, never global (RegExp#test with /g is
 * stateful). guardrails.ts runs them on the JOINED page text after NFKC + collapsing whitespace to
 * single spaces, never per text item (pdf.js splits runs at ligatures). Extend here, nowhere else.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /disregard .*instructions/i,
  /system prompt/i,
  /you are (now )?(an?|the) (ai|assistant|model)/i,
  /\bassistant:/i,
  /\bsystem:/i,
  /pre-?approved/i,
  /approve (this|the) invoice/i,
  /mark (as )?(paid|approved)/i,
  /do not (flag|mention|report)/i,
  /set (all|every) confidence/i,
  /override/i,
  /jailbreak/i,
];

export const CONFIG = {
  // ---- plan section 7, verbatim ----
  priceTolerancePct: 0.02, // <= 2% over the PO -> APPROVE with a warning
  minFieldConfidence: 0.75, // below this on a critical field -> HOLD
  softDuplicateWindowDays: 7,
  arithmeticTolerance: 0.02, // cents rounding
  maxInvoiceAgeDays: 365,
  maxFileBytes: 10 * 1024 * 1024,
  maxPages: 5,
  llmTimeoutMs: 45_000,
  stagePacingMs: 350, // ponytail: presentational pacing so the live view is readable; set 0 for batch
  injectionPatterns: INJECTION_PATTERNS,

  // ---- other numbers from plan sections 5, 6 and 9, kept here so there is one place for all of them ----
  imageOnlyMaxChars: 20, // fewer non-whitespace characters across all pages = image-only (scanned)
  tinyTextMaxPt: 3, // rendered height below this = tiny (excluded from grounding text)
  tinyTextMinWords: 4, // a run of consecutive tiny items with >= 4 words is flagged as hidden text
  groundingAmountTolerance: 0.01, // amounts match a visible numeric token within 1 cent
  paymentTermsDays: 30, // APPROVE next action: due_date, else invoice_date + 30 days
  extractMaxTokens: 8000, // reasoning tokens share this budget (docs/notes-openrouter.md 1.4)
  suggestPoMaxTokens: 4000,
  suggestPoReasoningMaxChars: 300,
  llmRetryAfterMaxMs: 10_000, // 429 Retry-After above this skips the same-model retry
  llmRetryAfterDefaultMs: 2_000, // 429 without Retry-After
  rateLimitPerIpPerMinute: 10,
  maxDisplayNameChars: 100,
} as const;

export type MockMode = "off" | "truth" | "fooled";

function envString(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * Environment readers. Getters read process.env at call time, so scripts can call
 * loadEnvForScripts() after importing this module and tests can set variables per case.
 */
export const ENV = {
  /** OpenRouter slug for the primary extraction model ("" if unset). */
  get extractModel(): string {
    return envString("EXTRACT_MODEL");
  },
  /** OpenRouter slug for the fallback model ("" if unset). */
  get fallbackModel(): string {
    return envString("FALLBACK_MODEL");
  },
  /** EXTRACT_MOCK: "1"/"true"/"truth" -> truth-JSON mock, "fooled" -> mock that applies _meta.injectedValues, else off. */
  get extractMock(): MockMode {
    const v = envString("EXTRACT_MOCK").toLowerCase();
    if (v === "fooled") return "fooled";
    if (v === "1" || v === "true" || v === "truth") return "truth";
    return "off";
  },
  /** Absolute path of DATA_DIR (default ./data, resolved against the project root = process.cwd()). */
  get dataDir(): string {
    return path.resolve(process.cwd(), envString("DATA_DIR") || "./data");
  },
  /** MAX_RUNS_PER_HOUR as a positive integer (default 60). */
  get maxRunsPerHour(): number {
    const n = Number.parseInt(envString("MAX_RUNS_PER_HOUR"), 10);
    return Number.isInteger(n) && n > 0 ? n : 60;
  },
  /** true only when DEMO_RESET_ENABLED is exactly "true". */
  get demoResetEnabled(): boolean {
    return envString("DEMO_RESET_ENABLED") === "true";
  },
  /** DEMO_RESET_TOKEN, or null when unset or shorter than 16 characters (reset must then be refused). */
  get demoResetToken(): string | null {
    const t = envString("DEMO_RESET_TOKEN");
    return t.length >= 16 ? t : null;
  },
};

/**
 * File locations. dataDir/dbFile/uploadsDir are writable runtime state under DATA_DIR. seed, samples
 * and fixtures are read-only repo assets under <project root>/data, independent of DATA_DIR (on
 * Railway, do not mount the volume over <root>/data or these disappear; see docs/CONTRACTS.md).
 */
export const paths = {
  get root(): string {
    return process.cwd();
  },
  get dataDir(): string {
    return ENV.dataDir;
  },
  get dbFile(): string {
    return path.join(ENV.dataDir, "app.db");
  },
  get uploadsDir(): string {
    return path.join(ENV.dataDir, "uploads");
  },
  get seedDir(): string {
    return path.join(process.cwd(), "data", "seed");
  },
  get samplesDir(): string {
    return path.join(process.cwd(), "data", "samples");
  },
  get truthDir(): string {
    return path.join(process.cwd(), "data", "samples", "truth");
  },
  get fixturesDir(): string {
    return path.join(process.cwd(), "data", "fixtures");
  },
};

/** Absolute path of a stored upload. Throws unless `hash` is 64 lowercase hex characters (path traversal guard). */
export function uploadPath(hash: string, uploadsDir: string = paths.uploadsDir): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid file hash");
  return path.join(uploadsDir, `${hash}.pdf`);
}

/**
 * Scripts only (tsx does not load .env files; Next.js does). Loads <root>/.env.local, then <root>/.env,
 * without overriding variables already set in the shell. Returns the files loaded.
 */
export function loadEnvForScripts(): string[] {
  const loaded: string[] = [];
  for (const name of [".env.local", ".env"]) {
    const file = path.join(process.cwd(), name);
    if (fs.existsSync(file)) {
      process.loadEnvFile(file);
      loaded.push(name);
    }
  }
  return loaded;
}
