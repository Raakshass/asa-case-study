/**
 * Layout "statement": a statement of account (sample 10, the wrong document). It lists balances only:
 * no invoice number, no PO number, no tax line, no due date, no bank account, and nothing labelled as an
 * invoice total. The truth file carries no amounts for it (subtotal / tax / total are null), so the
 * balances below are decoration: 15,180.00 is simply what samples 01 and 06 add up to for this vendor.
 */
import { type DocInput, type TemplateParts, brandFor, brandStyle, buyerBlock, esc, fmtDate, hiddenHtml, logoMark, money } from "./common";

/** Decorative balances (see the file comment). */
const BALANCES = {
  opening: 0,
  charges: 15180,
  payments: 0,
  closing: 15180,
  ageing: [
    { label: "Current", amount: 15180 },
    { label: "1-30 days", amount: 0 },
    { label: "31-60 days", amount: 0 },
    { label: "61-90 days", amount: 0 },
    { label: "Over 90 days", amount: 0 },
  ],
} as const;

const CSS = `
.st { font-size: 10pt; line-height: 1.42; padding: 14mm 16mm 0 16mm; }
.st .head { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 5mm; border-bottom: 0.6mm solid var(--accent); }
.st .logo { display: flex; align-items: center; gap: 3.2mm; }
.st .bn { font-size: 15pt; font-weight: 700; color: var(--accent-dark); line-height: 1.15; }
.st .tg { font-size: 7.8pt; color: var(--muted); letter-spacing: 0.04em; margin-top: 0.6mm; }
.st .addr { text-align: right; font-size: 8.8pt; color: var(--muted); line-height: 1.5; }
.st .titlebar { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 10mm; }
.st h1 { font-size: 21pt; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--accent); line-height: 1.1; }
.st table.meta { font-size: 9.6pt; }
.st table.meta td { padding: 0.8mm 0 0.8mm 4mm; white-space: nowrap; }
.st table.meta td.k { color: var(--muted); text-align: right; }
.st table.meta td.v { font-weight: 700; text-align: right; }
.st .cust { margin-top: 8mm; width: 86mm; background: var(--tint); border-left: 1mm solid var(--accent); padding: 3mm 4.4mm 3.4mm; }
.st h3 { margin: 10mm 0 2.6mm; font-size: 8.4pt; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent-dark); }
.st .cust h3 { margin: 0 0 1.4mm; }
.st .sum { font-size: 10.4pt; }
.st .sum .r { display: flex; justify-content: space-between; padding: 2.4mm 3mm; border-bottom: 0.25mm solid #d9d9d9; }
.st .sum .r .v { white-space: nowrap; }
.st .sum .r.close { background: var(--tint); font-weight: 700; border-top: 0.5mm solid var(--accent); border-bottom: 0; }
.st .age { font-size: 10pt; }
.st .age .ah, .st .age .av { display: grid; grid-template-columns: repeat(5, 1fr); text-align: right; padding: 0 3mm; white-space: nowrap; }
.st .age .ah { background: var(--accent); color: #fff; font-size: 8.4pt; letter-spacing: 0.06em; padding-top: 2.4mm; padding-bottom: 2.4mm; font-weight: 700; text-transform: uppercase; }
.st .age .av { padding-top: 3.2mm; padding-bottom: 3.2mm; border-bottom: 0.25mm solid #d9d9d9; }
.st .remit { margin-top: 10mm; font-size: 9.2pt; color: var(--muted); }
.st .foot { position: absolute; left: 16mm; right: 16mm; bottom: 11mm; border-top: 0.3mm solid #cfcfcf; padding-top: 2.4mm; display: flex; justify-content: space-between; font-size: 7.6pt; color: var(--muted); }
`;

export function renderStatement(doc: DocInput): TemplateParts {
  const { data, meta } = doc;
  const b = brandFor(data.vendor_name);
  const vendor = data.vendor_name ?? b.vendor;
  const date = (iso: string | null) => fmtDate(iso, b.dateStyle);

  const metaRows: string[] = [];
  if (data.invoice_date !== null) metaRows.push(`<tr><td class="k">Statement date:</td><td class="v">${date(data.invoice_date)}</td></tr>`);
  metaRows.push(`<tr><td class="k">Period:</td><td class="v">1 Oct 2026 - 31 Oct 2026</td></tr>`);
  if (data.currency !== null) metaRows.push(`<tr><td class="k">Currency:</td><td class="v">${esc(data.currency)}</td></tr>`);

  const body = `
<div class="page st" style="${brandStyle(b)}">
  <div class="head">
    <div class="logo">${logoMark(b)}<div><div class="bn">${esc(vendor)}</div><div class="tg">${esc(b.tagline)}</div></div></div>
    <div class="addr">${b.address.map(esc).join("<br>")}<br>Tel <span class="nw">${esc(b.phone)}</span><br>${esc(b.email)}</div>
  </div>
  <div class="titlebar">
    <h1>Statement of Account</h1>
    <table class="meta">${metaRows.join("")}</table>
  </div>
  <div class="cust"><h3>Customer</h3>${buyerBlock()}</div>
  <h3>Account summary</h3>
  <div class="sum">
    <div class="r"><span>Opening balance</span><span class="v">${money(BALANCES.opening)}</span></div>
    <div class="r"><span>Charges this period</span><span class="v">${money(BALANCES.charges)}</span></div>
    <div class="r"><span>Payments received</span><span class="v">${money(BALANCES.payments)}</span></div>
    <div class="r close"><span>Closing balance</span><span class="v">${money(BALANCES.closing)}</span></div>
  </div>
  <h3>Balances by age</h3>
  <div class="age">
    <div class="ah">${BALANCES.ageing.map((a) => `<span>${esc(a.label)}</span>`).join("")}</div>
    <div class="av">${BALANCES.ageing.map((a) => `<span>${money(a.amount)}</span>`).join("")}</div>
  </div>
  <p class="remit">Questions about this statement? Contact our accounts receivable team at ${esc(b.email)} or <span class="nw">${esc(b.phone)}</span>. Remittances: ${esc(vendor)}, ${b.address.map(esc).join(", ")}.</p>
  <div class="foot"><span>${esc(vendor)} &middot; Statement of account</span><span>Page 1 of 1</span></div>
  ${hiddenHtml(meta)}
</div>`;

  return { title: `Statement of account - ${vendor}`, css: CSS, body };
}
