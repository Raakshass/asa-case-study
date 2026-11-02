/**
 * Layout "compact": a dense ERP-style print. Small type, a 3x2 grid of "Label: value" cells instead of a
 * meta block, a thin-ruled item table and a short totals box in the upper half of the page.
 * Used by samples 04 (the disguised duplicate, deliberately unlike sample 02) and 07.
 */
import {
  BUYER,
  type DocInput,
  type TemplateParts,
  bankRows,
  brandFor,
  brandStyle,
  buyerBlock,
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
.cp { font-size: 8.8pt; line-height: 1.38; padding: 11mm 13mm 0 13mm; }
.cp .head { display: flex; justify-content: space-between; align-items: center; padding-bottom: 3.2mm; border-bottom: 0.6mm solid var(--ink); }
.cp .l { display: flex; align-items: center; gap: 3mm; }
.cp .l .mk { width: 9mm; height: 9mm; }
.cp .l .mk-acme::after { width: 4.2mm; height: 4.2mm; }
.cp .bn { font-size: 13pt; font-weight: 700; color: var(--ink); line-height: 1.15; }
.cp .ad { font-size: 7.8pt; color: var(--muted); margin-top: 0.6mm; }
.cp .r { font-size: 20pt; font-weight: 700; letter-spacing: 0.1em; color: var(--accent); }
.cp .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; margin-top: 4mm; border: 0.25mm solid #555; }
.cp .grid > div { padding: 1.7mm 2.4mm; border-right: 0.25mm solid #555; border-bottom: 0.25mm solid #555; white-space: nowrap; }
.cp .grid > div:nth-child(3n) { border-right: 0; }
.cp .grid > div:nth-last-child(-n+3) { border-bottom: 0; }
.cp .grid .k { color: var(--muted); }
.cp .grid .v { font-weight: 700; }
.cp .two { display: flex; gap: 5mm; margin-top: 4mm; }
.cp .two > div { flex: 1; border: 0.25mm solid #555; padding: 2.2mm 2.6mm; }
.cp .two h4 { font-size: 7.4pt; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent-dark); margin-bottom: 1mm; }
.cp .two table td { padding: 0.2mm 0; }
.cp .two table td.k { color: var(--muted); padding-right: 3mm; white-space: nowrap; }
.cp .two table td.v { font-weight: 700; white-space: nowrap; }
.cp .items { margin-top: 4mm; border: 0.25mm solid #555; }
.cp .ih, .cp .ir { display: grid; grid-template-columns: 1fr 18mm 30mm 30mm; align-items: start; padding: 0 2.4mm; }
.cp .ih { background: #ececec; font-size: 7.8pt; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding-top: 1.6mm; padding-bottom: 1.6mm; border-bottom: 0.25mm solid #555; }
.cp .ir { padding-top: 1.8mm; padding-bottom: 1.8mm; border-bottom: 0.2mm solid #bbb; }
.cp .ir:last-child { border-bottom: 0; }
.cp .n { text-align: right; white-space: nowrap; }
.cp .bottom { display: flex; justify-content: space-between; align-items: flex-start; gap: 6mm; margin-top: 3mm; }
.cp .terms { flex: 1; font-size: 8pt; color: var(--muted); }
.cp .tot { width: 64mm; border: 0.25mm solid #555; }
.cp .tot .tr { display: flex; justify-content: space-between; padding: 1.4mm 2.4mm; border-bottom: 0.2mm solid #bbb; }
.cp .tot .tr .v { white-space: nowrap; font-weight: 600; }
.cp .tot .tr.grand { background: #ececec; font-weight: 700; font-size: 9.6pt; border-bottom: 0; border-top: 0.3mm solid #555; }
.cp .slip { position: absolute; left: 13mm; right: 13mm; bottom: 24mm; }
.cp .slip .cut { border-top: 0.35mm dashed #777; padding-top: 1.6mm; font-size: 7.2pt; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
.cp .slip .sg { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1.6mm 4mm; margin-top: 2.4mm; border: 0.25mm solid #555; padding: 2.4mm 3mm; }
.cp .slip .sg .k { color: var(--muted); }
.cp .slip .sg .v { font-weight: 700; }
.cp .foot { position: absolute; left: 13mm; right: 13mm; bottom: 11mm; border-top: 0.2mm solid #bbb; padding-top: 2mm; font-size: 7.4pt; color: var(--muted); display: flex; justify-content: space-between; }
`;

export function renderCompact(doc: DocInput): TemplateParts {
  const { data, meta } = doc;
  const b = brandFor(data.vendor_name);
  const vendor = data.vendor_name ?? b.vendor;
  const terms = netTerms(data);
  const date = (iso: string | null) => fmtDate(iso, b.dateStyle);

  const cells: string[] = [];
  const cell = (k: string, v: string) => cells.push(`<div><span class="k">${esc(k)}</span> <span class="v">${v}</span></div>`);
  if (data.invoice_number !== null) cell("Invoice No:", esc(data.invoice_number));
  if (data.invoice_date !== null) cell("Invoice date:", date(data.invoice_date));
  if (data.due_date !== null) cell("Due date:", date(data.due_date));
  if (data.po_reference !== null) cell("PO Number:", esc(data.po_reference));
  if (terms !== null) cell("Terms:", esc(terms));
  if (data.currency !== null) cell("Currency:", esc(data.currency));
  while (cells.length % 3 !== 0) cells.push("<div></div>");

  const itemRows = data.line_items
    .map(
      (li) =>
        `<div class="ir"><span>${esc(li.description)}</span><span class="n">${qtyText(li.quantity)}</span><span class="n">${li.unit_price === null ? "" : money(li.unit_price)}</span><span class="n">${money(li.amount)}</span></div>`,
    )
    .join("");

  const totals = totalsRows(data, { subtotal: "Subtotal", tax: "Tax", total: "Invoice total" })
    .map((r) => `<div class="tr${r.grand ? " grand" : ""}"><span>${esc(r.label)}</span><span class="v">${r.value}</span></div>`)
    .join("");

  const bank = bankRows(b, data);
  const pay =
    bank === "" && noticeHtml(data) === ""
      ? ""
      : `<div><h4>Payment details</h4>${noticeHtml(data)}${bank === "" ? "" : `<table>${bank}</table>`}</div>`;
  const termsLine =
    terms !== null && data.due_date !== null
      ? `Terms: ${esc(terms)}. Payment due ${date(data.due_date)}. Please quote the invoice number with your payment.`
      : "Please quote the invoice number with your payment.";

  const slipCells: string[] = [`<div><span class="k">Customer:</span> <span class="v">${esc(BUYER.name)}</span></div>`];
  if (data.invoice_number !== null) slipCells.push(`<div><span class="k">Invoice No:</span> <span class="v">${esc(data.invoice_number)}</span></div>`);
  if (data.total !== null) slipCells.push(`<div><span class="k">Amount due:</span> <span class="v">${money(data.total)}</span></div>`);
  slipCells.push(`<div><span class="k">Pay to:</span> <span class="v">${esc(vendor)}</span></div>`);
  if (data.due_date !== null) slipCells.push(`<div><span class="k">Due date:</span> <span class="v">${date(data.due_date)}</span></div>`);

  const body = `
<div class="page cp" style="${brandStyle(b)}">
  <div class="head">
    <div class="l">${logoMark(b)}<div><div class="bn">${esc(vendor)}</div><div class="ad">${b.address.map(esc).join(", ")} &middot; Tel ${esc(b.phone)} &middot; ${esc(b.email)}</div></div></div>
    <div class="r">INVOICE</div>
  </div>
  <div class="grid">${cells.join("")}</div>
  <div class="two">
    <div><h4>Bill to</h4>${buyerBlock()}</div>
    ${pay}
  </div>
  <div class="items">
    <div class="ih"><span>Description</span><span class="n">Qty</span><span class="n">Unit price</span><span class="n">Amount</span></div>
    ${itemRows}
  </div>
  <div class="bottom">
    <div class="terms">${termsLine}</div>
    <div class="tot">${totals}</div>
  </div>
  <div class="slip"><div class="cut">Remittance advice &middot; detach here and return with your payment</div><div class="sg">${slipCells.join("")}</div></div>
  <div class="foot"><span>${esc(vendor)} &middot; Thank you for your business.</span><span>Page 1 of 1</span></div>
  ${hiddenHtml(meta)}
</div>`;

  return { title: `Invoice ${data.invoice_number ?? ""} - ${vendor}`.replace(/\s+/g, " ").trim(), css: CSS, body };
}
