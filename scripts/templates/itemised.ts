/**
 * Layout "itemised": the classic full-page invoice. Brand band on top, "INVOICE" and the meta block
 * on the right, bill-to / ship-to boxes, a ruled item table, totals with a highlighted grand total,
 * payment details and a footer. Used by samples 01, 02, 06 and 09.
 */
import {
  BUYER,
  type DocInput,
  type TemplateParts,
  bankRows,
  brandFor,
  brandStyle,
  buyerBlock,
  contactLine,
  esc,
  fmtDate,
  hiddenHtml,
  logoMark,
  money,
  netTerms,
  noticeHtml,
  qtyText,
  totalsRows,
} from "./common";

const CSS = `
.it { font-size: 9.6pt; line-height: 1.38; }
.it .band { height: 7mm; background: var(--accent); }
.it .wrap { padding: 9mm 14mm 0 14mm; }
.it .head { display: flex; justify-content: space-between; align-items: flex-start; }
.it .logo { display: flex; align-items: center; gap: 3.2mm; }
.it .bn { font-size: 16pt; font-weight: 700; color: var(--accent-dark); line-height: 1.15; }
.it .tg { font-size: 7.8pt; color: var(--muted); letter-spacing: 0.04em; margin-top: 0.6mm; }
.it .addr { margin-top: 4mm; font-size: 8.8pt; color: var(--muted); line-height: 1.5; }
.it .id { text-align: right; }
.it .ttl { font-size: 28pt; font-weight: 300; letter-spacing: 0.06em; color: var(--accent); line-height: 1; margin-bottom: 3.5mm; }
.it table.meta { margin-left: auto; font-size: 9.4pt; }
.it table.meta td { padding: 0.9mm 0 0.9mm 4mm; white-space: nowrap; }
.it table.meta td.k { color: var(--muted); text-align: right; }
.it table.meta td.v { font-weight: 700; text-align: right; min-width: 31mm; }
.it .parties { display: flex; gap: 6mm; margin-top: 9mm; }
.it .box { flex: 1; background: var(--tint); border-top: 0.7mm solid var(--accent); padding: 3mm 4mm 3.4mm; }
.it .box h4 { font-size: 7.8pt; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent-dark); margin-bottom: 1.4mm; }
.it .lines { margin-top: 8mm; min-height: 70mm; }
.it .ih, .it .ir { display: grid; grid-template-columns: 1fr 20mm 34mm 34mm; align-items: start; }
.it .ih { background: var(--accent); color: #fff; font-size: 8.2pt; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 700; padding: 2.4mm 3mm; }
.it .ir { padding: 3.2mm 3mm; border-bottom: 0.25mm solid #d9d9d9; }
.it .ir .d { font-weight: 600; }
.it .n { text-align: right; white-space: nowrap; }
.it .sum { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; margin-top: 2mm; }
.it .pay { flex: 1; font-size: 8.8pt; }
.it .pay h4 { font-size: 7.8pt; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent-dark); margin-bottom: 1.6mm; }
.it .pay table td { padding: 0.5mm 0; }
.it .pay table td.k { color: var(--muted); padding-right: 4mm; white-space: nowrap; }
.it .pay table td.v { font-weight: 700; white-space: nowrap; }
.it .pay p { margin-top: 3mm; color: var(--muted); }
.it .tot { width: 78mm; font-size: 9.8pt; }
.it .tot .tr { display: flex; justify-content: space-between; align-items: baseline; padding: 1.7mm 3mm; }
.it .tot .tr .k { color: var(--muted); }
.it .tot .tr .v { font-weight: 600; white-space: nowrap; }
.it .tot .tr.grand { background: var(--accent); padding: 2.6mm 3mm; font-size: 11.4pt; }
.it .tot .tr.grand .k, .it .tot .tr.grand .v { color: #fff; font-weight: 700; }
.it .thanks { margin-top: 9mm; font-size: 10pt; font-weight: 700; color: var(--accent-dark); }
.it .fine { position: absolute; left: 14mm; right: 14mm; bottom: 24mm; font-size: 7.4pt; line-height: 1.5; color: var(--muted); }
.it .fine b { color: var(--accent-dark); }
.it .foot { position: absolute; left: 14mm; right: 14mm; bottom: 11mm; border-top: 0.3mm solid #cfcfcf; padding-top: 2.4mm; display: flex; justify-content: space-between; font-size: 7.6pt; color: var(--muted); }
`;

export function renderItemised(doc: DocInput): TemplateParts {
  const { data, meta } = doc;
  const b = brandFor(data.vendor_name);
  const vendor = data.vendor_name ?? b.vendor;
  const terms = netTerms(data);
  const date = (iso: string | null) => fmtDate(iso, b.dateStyle);

  const metaRows: string[] = [];
  if (data.invoice_number !== null) metaRows.push(`<tr><td class="k">Invoice No:</td><td class="v">${esc(data.invoice_number)}</td></tr>`);
  if (data.invoice_date !== null) metaRows.push(`<tr><td class="k">Invoice date:</td><td class="v">${date(data.invoice_date)}</td></tr>`);
  if (data.due_date !== null) metaRows.push(`<tr><td class="k">Due date:</td><td class="v">${date(data.due_date)}</td></tr>`);
  if (data.po_reference !== null) metaRows.push(`<tr><td class="k">PO Number:</td><td class="v">${esc(data.po_reference)}</td></tr>`);
  if (terms !== null) metaRows.push(`<tr><td class="k">Terms:</td><td class="v">${esc(terms)}</td></tr>`);
  if (data.currency !== null) metaRows.push(`<tr><td class="k">Currency:</td><td class="v">${esc(data.currency)}</td></tr>`);

  const itemRows = data.line_items
    .map(
      (li) =>
        `<div class="ir"><span class="d">${esc(li.description)}</span><span class="n">${qtyText(li.quantity)}</span><span class="n">${li.unit_price === null ? "" : money(li.unit_price)}</span><span class="n">${money(li.amount)}</span></div>`,
    )
    .join("");

  const totals = totalsRows(data, { subtotal: "Subtotal", tax: "Tax", total: "Total due" })
    .map((r) => `<div class="tr${r.grand ? " grand" : ""}"><span class="k">${esc(r.label)}</span><span class="v">${r.value}</span></div>`)
    .join("");

  const bank = bankRows(b, data);
  const termsLine =
    terms !== null && data.due_date !== null
      ? `Payment terms: ${esc(terms)}. Please pay by bank transfer by ${date(data.due_date)}, quoting the invoice number.`
      : "Please pay by bank transfer, quoting the invoice number.";

  const body = `
<div class="page it" style="${brandStyle(b)}">
  <div class="band"></div>
  <div class="wrap">
    <div class="head">
      <div>
        <div class="logo">${logoMark(b)}<div><div class="bn">${esc(vendor)}</div><div class="tg">${esc(b.tagline)}</div></div></div>
        <div class="addr">${b.address.map(esc).join("<br>")}<br>${contactLine(b)}</div>
      </div>
      <div class="id">
        <div class="ttl">INVOICE</div>
        <table class="meta">${metaRows.join("")}</table>
      </div>
    </div>
    <div class="parties">
      <div class="box"><h4>Bill to</h4>${buyerBlock()}</div>
      <div class="box"><h4>Ship to</h4>${BUYER.site.map(esc).join("<br>")}<br>${esc(BUYER.name)}</div>
    </div>
    <div class="lines">
      <div class="ih"><span>Description</span><span class="n">Qty</span><span class="n">Unit price</span><span class="n">Amount</span></div>
      ${itemRows}
    </div>
    <div class="sum">
      <div class="pay">
        <h4>Payment details</h4>
        ${noticeHtml(data)}
        ${bank === "" ? "" : `<table>${bank}</table>`}
        <p>${termsLine}</p>
      </div>
      <div class="tot">${totals}</div>
    </div>
    <div class="thanks">Thank you for your business.</div>
  </div>
  <div class="fine"><b>Terms and conditions.</b> Overdue balances may be charged interest at 1.5% per month. All goods and services are supplied under our standard terms of sale. Queries about this document must be raised within 14 days of the invoice date.</div>
  <div class="foot"><span>${esc(vendor)} &middot; ${b.address.map(esc).join(", ")}</span><span>Page 1 of 1</span></div>
  ${hiddenHtml(meta)}
</div>`;

  return { title: `Invoice ${data.invoice_number ?? ""} - ${vendor}`.replace(/\s+/g, " ").trim(), css: CSS, body };
}
