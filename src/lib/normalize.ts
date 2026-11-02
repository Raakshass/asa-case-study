/**
 * Stage 5 normalization (IMPLEMENTATION_PLAN.md section 7): dates to ISO, invoice number to its
 * canonical form, vendor resolution against the master. Pure functions (no fs/db/network/clock).
 *
 * OWNER: Phase 3. normalizeInvoiceNumber and VENDOR_SUFFIXES are final (normalizeInvoiceNumber must equal
 * format.ts normId, which the seed uses for history rows). Keep every exported signature (docs/CONTRACTS.md).
 * Everything here treats its input as untrusted text and never throws on odd input.
 */
import { isIsoDate, normId } from "./format";
import type { InvoiceExtraction, NormalizedInvoice, Vendor } from "./types";

/** Legal suffixes stripped from vendor names before matching (plan section 7, stage 5). */
export const VENDOR_SUFFIXES = ["inc", "llc", "ltd", "co", "corp", "pty"] as const;

/** "INV-0042" -> "INV0042"; null or no alphanumerics -> null. Equal to normId so history rows match. */
export function normalizeInvoiceNumber(value: string | null): string | null {
  if (value === null) return null;
  const n = normId(value);
  return n === "" ? null : n;
}

/* ================================================================================================
 * Dates
 * ============================================================================================== */

const MONTHS = new Map<string, number>(
  Object.entries({
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  }),
);

/** "YYYY-MM-DD" for a real calendar date, else null (2026-02-30, month 13, year 0001 ...). */
function toIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1000 || year > 9999) return null;
  const iso = `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * Printed date -> "YYYY-MM-DD", or null when missing, impossible (2026-02-30) or ambiguous/unparseable.
 * Accepts ISO already (with or without a time part), year-first "2026/10/28", month names ("28 Oct 2026",
 * "October 28, 2026", "28th of October 2026", "Tue, 28-Oct-2026") and numeric day/month/year only when the
 * order is forced by the numbers ("28/10/2026" can only be day first, "10/28/2026" only month first, and
 * "05/05/2026" reads the same both ways). Never guesses dd/mm vs mm/dd: "05/06/2026" -> null. Two-digit
 * years are never guessed either.
 */
export function normalizeDate(value: string | null): string | null {
  if (value === null || typeof value !== "string") return null;
  const raw = value.normalize("NFKC").trim();
  if (raw === "" || raw.length > 60) return null;

  // ISO 8601 date, optionally followed by a time and zone: the printed calendar date is kept as is.
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?$/i.exec(raw);
  if (m) return toIso(Number(m[1]), Number(m[2]), Number(m[3]));

  // Year first with "/" or ".": 2026/10/28, 2026.10.28
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(raw);
  if (m) return toIso(Number(m[1]), Number(m[2]), Number(m[3]));

  // Numeric with the year last: only when the numbers force day-first or month-first.
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3]);
    if (a > 12 && b <= 12) return toIso(year, b, a); // day/month/year
    if (b > 12 && a <= 12) return toIso(year, a, b); // month/day/year
    if (a === b && a <= 12) return toIso(year, a, b); // same either way
    return null; // ambiguous (05/06/2026) or impossible (31/31/2026)
  }

  // Month names.
  const words = raw
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/[-/]/g, " ")
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, "$1")
    .replace(/\bof\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]* /, "");
  m = /^(\d{1,2}) ([a-z]+) (\d{4})$/.exec(words);
  if (m) {
    const month = MONTHS.get(m[2]);
    return month === undefined ? null : toIso(Number(m[3]), month, Number(m[1]));
  }
  m = /^([a-z]+) (\d{1,2}) (\d{4})$/.exec(words);
  if (m) {
    const month = MONTHS.get(m[1]);
    return month === undefined ? null : toIso(Number(m[3]), month, Number(m[2]));
  }
  return null;
}

/* ================================================================================================
 * Vendors
 * ============================================================================================== */

const SUFFIX_SET: ReadonlySet<string> = new Set<string>(VENDOR_SUFFIXES);

/** Long legal forms read as their short form, so "Globex Logistics Limited" matches "Globex Logistics Ltd". */
const SUFFIX_LONG_FORMS: ReadonlyMap<string, string> = new Map([
  ["incorporated", "inc"],
  ["limited", "ltd"],
  ["corporation", "corp"],
  ["company", "co"],
]);

/**
 * Multi-word legal forms, folded before the single words above (so "limited" is not read as "ltd" inside
 * "limited liability company"): "Northwind IT Solutions Limited Liability Company" is Northwind IT Solutions LLC,
 * "Globex Logistics Proprietary Limited" is Globex Logistics Pty Ltd (red team RT-RULES-06).
 */
const MULTI_WORD_FORMS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [["limited", "liability", "company"], ["llc"]],
  [["limited", "liability", "co"], ["llc"]],
  [["proprietary", "limited"], ["pty", "ltd"]],
  [["proprietary"], ["pty"]],
];

function foldLegalForms(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const form = MULTI_WORD_FORMS.find(([words]) => words.every((w, k) => tokens[i + k] === w));
    if (form) {
      out.push(...form[1]);
      i += form[0].length;
    } else {
      out.push(SUFFIX_LONG_FORMS.get(tokens[i]) ?? tokens[i]);
      i++;
    }
  }
  return out;
}

/**
 * Lowercase, accents folded, punctuation removed, whitespace collapsed, trailing VENDOR_SUFFIXES removed
 * ("Acme Office Supplies, Inc." -> "acme office supplies"). Periods and apostrophes vanish ("L.L.C." -> "llc",
 * "St. John's" -> "st johns"), "&" reads as "and", other punctuation separates words. Long legal forms
 * (incorporated, limited, corporation, company; limited liability company/co, proprietary limited,
 * proprietary) count as their short form. A name that is nothing but suffixes keeps them. null when the input
 * is null or has no letters or digits.
 */
export function normalizeVendorName(value: string | null): string | null {
  if (value === null || typeof value !== "string") return null;
  const folded = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (folded === "") return null;
  const tokens = foldLegalForms(folded.split(" "));
  while (tokens.length > 1 && SUFFIX_SET.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

/**
 * Every distinct vendor whose normalized name or any normalized alias equals the normalized `name`.
 * [] for no match, 2+ entries when the name is ambiguous (the caller must not guess between them).
 */
export function findVendorMatches(name: string | null, vendors: readonly Vendor[]): Vendor[] {
  const key = normalizeVendorName(name);
  if (key === null) return [];
  const found = new Map<string, Vendor>();
  for (const vendor of vendors) {
    if (found.has(vendor.id)) continue;
    const names = [vendor.name, ...vendor.aliases];
    if (names.some((n) => normalizeVendorName(n) === key)) found.set(vendor.id, vendor);
  }
  return [...found.values()];
}

/**
 * Exact match of normalizeVendorName(name) against each vendor's normalized name and aliases; else null.
 * An ambiguous name (it matches two different vendors) also gives null: never guess.
 */
export function resolveVendor(name: string | null, vendors: readonly Vendor[]): Vendor | null {
  const matches = findVendorMatches(name, vendors);
  return matches.length === 1 ? matches[0] : null;
}

/* ================================================================================================
 * PO reference, currency, whole invoice
 * ============================================================================================== */

/** normId of the printed PO reference ("PO 1003" -> "PO1003"); null when absent or empty. */
export function normalizePoReference(value: string | null): string | null {
  if (value === null || typeof value !== "string") return null;
  const n = normId(value);
  return n === "" ? null : n;
}

/** Symbols and words read as a currency (a USD-only demo: "$" is dollars). "¥" is ambiguous (JPY or CNY) and unrecognised. */
const CURRENCY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["$", "USD"],
  ["US$", "USD"],
  ["USD$", "USD"],
  ["USDOLLAR", "USD"],
  ["USDOLLARS", "USD"],
  ["UNITEDSTATESDOLLAR", "USD"],
  ["UNITEDSTATESDOLLARS", "USD"],
  ["€", "EUR"],
  ["EURO", "EUR"],
  ["EUROS", "EUR"],
  ["£", "GBP"],
  ["₹", "INR"],
]);

let knownCurrencies: ReadonlySet<string> | null | undefined;

/** The ISO 4217 codes this runtime knows, or null when it cannot list them (then any 3 letters pass). */
function isoCurrencies(): ReadonlySet<string> | null {
  if (knownCurrencies === undefined) {
    try {
      const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
      knownCurrencies = intl.supportedValuesOf ? new Set(intl.supportedValuesOf("currency")) : null;
    } catch {
      knownCurrencies = null;
    }
  }
  return knownCurrencies;
}

/**
 * Uppercase 3-letter ISO 4217 ("usd" -> "USD"; "$" and "US$" map to "USD" in this USD-only demo, "€" to
 * "EUR", "£" to "GBP"); null when missing or unrecognised ("FOO", "dollars", "¥"). Unrecognised is not the
 * same as missing: rules.ts holds an invoice whose currency was printed but cannot be read.
 */
export function normalizeCurrency(value: string | null): string | null {
  if (value === null || typeof value !== "string") return null;
  const s = value.normalize("NFKC").trim().toUpperCase();
  if (s === "") return null;
  if (/^[A-Z]{3}$/.test(s)) {
    const known = isoCurrencies();
    return known === null || known.has(s) ? s : null;
  }
  return CURRENCY_ALIASES.get(s.replace(/[\s.]/g, "")) ?? null;
}

/** Trimmed text, or null when null or blank. */
function clean(value: string | null): string | null {
  if (value === null || typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

/** All of the above for one extraction. Blank strings count as missing (null). Never throws. */
export function normalizeInvoice(extraction: InvoiceExtraction, vendors: readonly Vendor[]): NormalizedInvoice {
  const vendorName = clean(extraction.vendor_name);
  const invoiceNumber = clean(extraction.invoice_number);
  const poReference = clean(extraction.po_reference);
  const bank = clean(extraction.bank_account);
  const bankNorm = bank === null ? null : normId(bank);
  return {
    vendor_name: vendorName,
    vendor_name_norm: normalizeVendorName(vendorName),
    vendor_id: resolveVendor(vendorName, vendors)?.id ?? null,
    invoice_number: invoiceNumber,
    invoice_number_norm: normalizeInvoiceNumber(invoiceNumber),
    invoice_date: normalizeDate(extraction.invoice_date),
    due_date: normalizeDate(extraction.due_date),
    po_reference: poReference,
    po_reference_norm: normalizePoReference(poReference),
    currency: normalizeCurrency(extraction.currency),
    bank_account_norm: bankNorm === "" ? null : bankNorm,
  };
}
