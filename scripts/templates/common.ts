/**
 * Shared pieces of the sample-invoice HTML templates (Phase 1b, scripts/gen-invoices.ts).
 *
 * Everything printed on a sample comes from its truth file (data/samples/truth/NN.json): numbers, dates,
 * PO reference, line items, bank account, notes and the hidden sentence. Only the look (vendor brand,
 * addresses, bank names, the buyer) is defined here. Text logos and CSS shapes only: no network
 * images, no web fonts, no letters inside the logo marks (they would leak stray tokens into the text layer).
 *
 * Every interpolated value goes through esc(). Nothing here reads a file or builds a path.
 */
import { daysBetweenIso, formatUsd, isIsoDate } from "../../src/lib/format";
import type { TruthMeta } from "../../src/lib/samples";
import type { InvoiceExtraction } from "../../src/lib/types";

/** What a template needs: the truth extraction (what the PDF must show) and its _meta. */
export interface DocInput {
  /** "01".."10" */
  id: string;
  data: InvoiceExtraction;
  meta: TruthMeta;
}

/** A rendered template: page markup plus the CSS it needs on top of BASE_CSS. */
export interface TemplateParts {
  title: string;
  css: string;
  body: string;
}

export type DateStyle = "iso" | "us-slash" | "mdy-long" | "dmy-long" | "dmy-short";
export type LogoKind = "acme" | "northwind" | "globex" | "initech" | "umbrella" | "plain";

/** How one vendor presents itself, independent of the layout (the same vendor keeps its brand across layouts). */
export interface Brand {
  /** vendor_name exactly as in the truth files */
  vendor: string;
  /** CSS font stack; single quotes only (it is placed in a style attribute) */
  fontStack: string;
  accent: string;
  accentDark: string;
  tint: string;
  ink: string;
  muted: string;
  logo: LogoKind;
  tagline: string;
  address: string[];
  phone: string;
  email: string;
  web: string;
  dateStyle: DateStyle;
  bankName: string;
}

const BRANDS: Brand[] = [
  {
    vendor: "Acme Office Supplies Inc.",
    fontStack: "Palatino, 'Palatino Linotype', 'Book Antiqua', Charter, 'Times New Roman', serif",
    accent: "#b3202a",
    accentDark: "#7c151c",
    tint: "#fbeff0",
    ink: "#241f20",
    muted: "#6f6667",
    logo: "acme",
    tagline: "Everything for the working office",
    address: ["2175 Market Street, Suite 12", "San Francisco, CA 94114"],
    phone: "+1 415 555 0101",
    email: "billing@acmesupplies.example",
    web: "www.acmesupplies.example",
    dateStyle: "mdy-long",
    bankName: "Pacific Coast Bank",
  },
  {
    vendor: "Northwind IT Solutions LLC",
    fontStack: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    accent: "#0f5fa8",
    accentDark: "#0a3d6b",
    tint: "#ebf3fa",
    ink: "#1b2733",
    muted: "#5d6b7a",
    logo: "northwind",
    tagline: "Managed IT, hardware and cloud",
    address: ["500 Harbor Way, Suite 210", "Redwood City, CA 94065"],
    phone: "+1 415 555 0102",
    email: "accounts@northwindit.example",
    web: "www.northwindit.example",
    dateStyle: "dmy-short",
    bankName: "Harborview Savings Bank",
  },
  {
    vendor: "Globex Logistics Ltd",
    fontStack: "'Trebuchet MS', 'Lucida Grande', Verdana, sans-serif",
    accent: "#0b7a5b",
    accentDark: "#064e3b",
    tint: "#e8f5f0",
    ink: "#16241f",
    muted: "#587068",
    logo: "globex",
    tagline: "Freight, warehousing and installation",
    address: ["77 Dockside Road", "South San Francisco, CA 94080"],
    phone: "+1 415 555 0103",
    email: "billing@globexlogistics.example",
    web: "www.globexlogistics.example",
    dateStyle: "us-slash",
    bankName: "Bayshore Commercial Bank",
  },
  {
    vendor: "Initech Facilities Co.",
    fontStack: "Verdana, Geneva, 'DejaVu Sans', sans-serif",
    accent: "#c2410c",
    accentDark: "#7c2d12",
    tint: "#fff0e6",
    ink: "#26211d",
    muted: "#6e625a",
    logo: "initech",
    tagline: "Building services you can count on",
    address: ["1500 Industrial Parkway", "Fremont, CA 94538"],
    phone: "+1 415 555 0104",
    email: "office@initechfacilities.example",
    web: "www.initechfacilities.example",
    dateStyle: "mdy-long",
    bankName: "Sutter Street Trust",
  },
  {
    vendor: "Umbrella Consulting",
    fontStack: "'Avenir Next', Avenir, 'Segoe UI', Candara, sans-serif",
    accent: "#5b3a8c",
    accentDark: "#3b2260",
    tint: "#f1ecf8",
    ink: "#221f2b",
    muted: "#6a6578",
    logo: "umbrella",
    tagline: "Strategy and operations advisory",
    address: ["30 Corporate Drive, Floor 4", "Palo Alto, CA 94301"],
    phone: "+1 650 555 0188",
    email: "finance@umbrellaconsulting.example",
    web: "www.umbrellaconsulting.example",
    dateStyle: "iso",
    bankName: "Peninsula National Bank",
  },
];

/** Brand for a vendor name; an unknown vendor gets a neutral grey brand so the generator never crashes. */
export function brandFor(vendorName: string | null): Brand {
  const found = BRANDS.find((b) => b.vendor === vendorName);
  if (found) return found;
  return {
    vendor: vendorName ?? "Vendor",
    fontStack: "Arial, Helvetica, sans-serif",
    accent: "#374151",
    accentDark: "#111827",
    tint: "#f3f4f6",
    ink: "#1f2937",
    muted: "#6b7280",
    logo: "plain",
    tagline: "",
    address: ["1 Main Street", "Springfield, CA 90000"],
    phone: "+1 415 555 0100",
    email: "billing@vendor.example",
    web: "www.vendor.example",
    dateStyle: "iso",
    bankName: "Community Bank",
  };
}

/** The company the invoices are addressed to (our side of the demo). No "400" or "1003" anywhere: sample 09 must stay clean. */
export const BUYER = {
  name: "Larkspur Retail Group, Inc.",
  dept: "Accounts Payable",
  address: ["1200 Embarcadero Plaza, Floor 9", "San Francisco, CA 94111"],
  site: ["Receiving Dock B", "88 Bayside Road, Hayward, CA 94545"],
} as const;

/** HTML-escape every value that goes into markup or an attribute. */
export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** "$1,150.00" (the way people print it), already HTML-safe. */
export function money(n: number): string {
  return esc(formatUsd(n));
}

/** Whole numbers stay whole ("10"), fractions keep their digits ("1.5"). */
export function qtyText(n: number | null): string {
  return n === null ? "" : String(n);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** ISO date -> the vendor's printed style, e.g. "October 24, 2026", "22 Oct 2026", "10/26/2026", "2026-10-23". */
export function fmtDate(iso: string | null, style: DateStyle): string {
  if (iso === null) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return esc(iso);
  const [, y, mo, d] = m;
  const month = MONTHS[Number(mo) - 1] ?? mo;
  const day = Number(d);
  switch (style) {
    case "iso":
      return `${y}-${mo}-${d}`;
    case "us-slash":
      return `${mo}/${d}/${y}`;
    case "mdy-long":
      return `${month} ${day}, ${y}`;
    case "dmy-long":
      return `${day} ${month} ${y}`;
    case "dmy-short":
      return `${day} ${month.slice(0, 3)} ${y}`;
  }
}

/** "Net 30" when both dates are printed and apart by a whole number of days, else null. */
export function netTerms(data: InvoiceExtraction): string | null {
  if (data.invoice_date === null || data.due_date === null) return null;
  if (!isIsoDate(data.invoice_date) || !isIsoDate(data.due_date)) return null;
  const days = daysBetweenIso(data.invoice_date, data.due_date);
  return days > 0 ? `Net ${days}` : null;
}

/** Tax rate as printed next to the tax line: "10", "7.5"; null when it cannot be derived. */
export function taxRateText(data: InvoiceExtraction): string | null {
  if (data.tax === null || data.subtotal === null || data.subtotal <= 0) return null;
  const pct = Math.round((data.tax / data.subtotal) * 1000) / 10;
  return String(pct);
}

/**
 * The rows of the totals box (subtotal, tax, grand total) from the truth numbers; a null number gets no row.
 * Each template passes its own wording for the three labels. A tax-inclusive document says so on the tax line.
 */
export function totalsRows(data: InvoiceExtraction, labels: { subtotal: string; tax: string; total: string }): { label: string; value: string; grand: boolean }[] {
  const rows: { label: string; value: string; grand: boolean }[] = [];
  if (data.subtotal !== null) rows.push({ label: labels.subtotal, value: money(data.subtotal), grand: false });
  if (data.tax !== null) {
    const rate = taxRateText(data);
    const base = data.tax_inclusive ? `${labels.tax} included` : labels.tax;
    rows.push({ label: rate === null ? base : `${base} (${rate}%)`, value: money(data.tax), grand: false });
  }
  if (data.total !== null) rows.push({ label: labels.total, value: money(data.total), grand: true });
  return rows;
}

/** CSS custom properties + font of the brand, for the style attribute of a page element. */
export function brandStyle(b: Brand): string {
  return esc(`--accent:${b.accent};--accent-dark:${b.accentDark};--tint:${b.tint};--ink:${b.ink};--muted:${b.muted};font-family:${b.fontStack}`);
}

/** The logo mark: a CSS shape (no letters). */
export function logoMark(b: Brand): string {
  return `<span class="mk mk-${b.logo}" aria-hidden="true"></span>`;
}

/** Bank block rows (bank name, account name, account number) or "" when the truth has no bank account. */
export function bankRows(b: Brand, data: InvoiceExtraction): string {
  if (data.bank_account === null) return "";
  const name = data.vendor_name ?? b.vendor;
  return [
    `<tr><td class="k">Bank:</td><td class="v">${esc(b.bankName)}</td></tr>`,
    `<tr><td class="k">Account name:</td><td class="v">${esc(name)}</td></tr>`,
    `<tr><td class="k">Account no:</td><td class="v">${esc(data.bank_account)}</td></tr>`,
  ].join("");
}

/** A visible notice for whatever the truth lists under notes (sample 06: the new-bank-details line). "" when empty. */
export function noticeHtml(data: InvoiceExtraction): string {
  const text = data.notes.trim();
  return text === "" ? "" : `<div class="notice">${esc(text)}</div>`;
}

/**
 * The hidden sentence (sample 09 only): white text at CSS 1px (0.75pt in the PDF), inside the printable
 * page at the very bottom over white paper. Invisible to a reader, present in the text layer.
 */
export function hiddenHtml(meta: TruthMeta): string {
  return meta.hiddenText === null ? "" : `<div class="hx">${esc(meta.hiddenText)}</div>`;
}

/** Vendor contact line pieces for letterheads. */
export function contactLine(b: Brand): string {
  return `Tel ${esc(b.phone)} &middot; ${esc(b.email)} &middot; ${esc(b.web)}`;
}

/** Buyer lines as escaped HTML with <br>. */
export function buyerBlock(): string {
  return [BUYER.name, BUYER.dept, ...BUYER.address].map(esc).join("<br>");
}

/** Reset, page box, logo marks, notice and the hidden-text block; shared by every layout. */
export const BASE_CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #fff; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
table { border-collapse: collapse; border-spacing: 0; }
.page { position: relative; width: 210mm; height: 296.5mm; overflow: hidden; background: #fff; color: var(--ink); }
.nw { white-space: nowrap; }

/* ---- logo marks: pure CSS shapes, no text ---- */
.mk { position: relative; display: inline-block; width: 11mm; height: 11mm; flex: none; }
.mk-acme { background: var(--accent); border-radius: 1.6mm; }
.mk-acme::after { content: ""; position: absolute; left: 50%; top: 50%; width: 5.2mm; height: 5.2mm; background: #fff; transform: translate(-50%, -50%) rotate(45deg); }
.mk-northwind { background: var(--accent); border-radius: 50%; }
.mk-northwind::before { content: ""; position: absolute; left: 2.1mm; top: 2.1mm; right: 2.1mm; bottom: 2.1mm; border: 0.6mm solid #fff; border-radius: 50%; }
.mk-northwind::after { content: ""; position: absolute; left: 50%; top: 50%; width: 2.4mm; height: 2.4mm; background: #fff; border-radius: 50%; transform: translate(-50%, -50%); }
.mk-globex { border: 0.8mm solid var(--accent); border-radius: 50%; }
.mk-globex::before { content: ""; position: absolute; left: 50%; top: -0.8mm; bottom: -0.8mm; width: 5mm; margin-left: -2.5mm; border: 0.5mm solid var(--accent); border-radius: 50%; }
.mk-globex::after { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 0.5mm; margin-top: -0.25mm; background: var(--accent); }
.mk-initech { background: var(--accent); clip-path: polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%); }
.mk-initech::after { content: ""; position: absolute; left: 50%; top: 50%; width: 5mm; height: 5mm; background: #fff; transform: translate(-50%, -50%); clip-path: polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%); }
.mk-umbrella::before { content: ""; position: absolute; left: 0; top: 0.4mm; width: 11mm; height: 5.6mm; background: var(--accent); border-radius: 5.5mm 5.5mm 0.6mm 0.6mm; }
.mk-umbrella::after { content: ""; position: absolute; left: 5.1mm; top: 6mm; width: 2.4mm; height: 4.6mm; border-left: 0.7mm solid var(--accent); border-bottom: 0.7mm solid var(--accent); border-radius: 0 0 0 1.6mm; }
.mk-plain { background: var(--accent); border-radius: 1mm; }

/* ---- notice (sample 06 prints its note this way) ---- */
.notice { display: block; margin: 0 0 2.2mm; padding: 1.8mm 2.6mm; background: #fff3d1; border-left: 1.2mm solid #d89a00; color: #6b4600; font-weight: 700; }

/* ---- hidden text (sample 09): white, CSS 1px = 0.75pt, inside the page, over white paper ---- */
.hx { position: absolute; left: 14mm; right: 14mm; bottom: 4mm; font-size: 1px; line-height: 1.25; color: #fff; background: transparent; font-weight: 400; letter-spacing: 0; text-transform: none; }
`;

/** Complete HTML document for the PDF (Chromium page.pdf). */
export function pdfDocument(parts: TemplateParts): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(parts.title)}</title>
<style>${BASE_CSS}${parts.css}</style></head>
<body>${parts.body}</body></html>`;
}

/**
 * Complete HTML document for the scanned look (sample 05): the same page, rotated 0.7 degrees on a
 * scanner bed, greyscale, contrast 1.15, a slight blur and a faint noise overlay. Screenshotted to JPEG
 * by gen-invoices.ts; the PDF built from it has no text layer.
 */
export function scanDocument(parts: TemplateParts): string {
  const noise =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'>" +
        "<filter id='n' x='0' y='0' width='100%' height='100%'>" +
        "<feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='7' stitchTiles='stitch'/>" +
        "<feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.9 -0.28'/>" +
        "</filter><rect width='100%' height='100%' filter='url(#n)'/></svg>",
    );
  const scanCss = `
html, body { width: 210mm; height: 297mm; overflow: hidden; background: #d6d6d2; }
.scan-wrap { position: relative; width: 210mm; height: 297mm; overflow: hidden; background: #d6d6d2; filter: grayscale(1) contrast(1.15) blur(0.4px); }
.sheet { position: absolute; left: 0; top: 0; width: 210mm; height: 297mm; background: #fbfbf8; transform: rotate(0.7deg) scale(1.02); transform-origin: 50% 50%; }
.sheet .page { height: 297mm; background: transparent; }
.sheet::after { content: ""; position: absolute; left: 0; top: 0; right: 0; bottom: 0; pointer-events: none;
  background: linear-gradient(90deg, rgba(0,0,0,0.07) 0, rgba(0,0,0,0) 5%, rgba(0,0,0,0) 94%, rgba(0,0,0,0.09) 100%), linear-gradient(180deg, rgba(0,0,0,0.04) 0, rgba(0,0,0,0) 4%, rgba(0,0,0,0) 96%, rgba(0,0,0,0.06) 100%); }
.noise { position: absolute; left: 0; top: 0; right: 0; bottom: 0; pointer-events: none; opacity: 0.42; mix-blend-mode: multiply; background-image: url("${noise}"); background-size: 320px 320px; }
`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scan</title>
<style>${BASE_CSS}${parts.css}${scanCss}</style></head>
<body><div class="scan-wrap"><div class="sheet">${parts.body}</div><div class="noise"></div></div></body></html>`;
}
