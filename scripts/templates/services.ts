/**
 * Layout "services": a centred letterhead and one bundled "Services rendered" block instead of an
 * item table (each service is a description with its "qty x rate" underneath and one amount).
 * Used by samples 03, 05 (rendered as a scan) and 08.
 */
import {
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
.sv { font-size: 10pt; line-height: 1.42; padding: 13mm 15mm 0 15mm; }
.sv .top { text-align: center; }
.sv .top .mk { margin-bottom: 2.4mm; }
.sv .bn { font-size: 19pt; font-weight: 700; color: var(--accent-dark); line-height: 1.15; }
.sv .tg { font-size: 8pt; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); margin-top: 1mm; }
.sv .addr { margin-top: 3.2mm; font-size: 8.8pt; color: var(--muted); line-height: 1.55; }
.sv .rule { height: 0.5mm; background: var(--accent); margin-top: 5mm; }
.sv .rule2 { height: 0.2mm; background: var(--accent); margin-top: 0.8mm; }
.sv .grid { display: flex; justify-content: space-between; gap: 8mm; margin-top: 8mm; }
.sv .to { flex: 1; }
.sv .to h4, .sv .remit h4 { font-size: 8pt; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent-dark); margin-bottom: 1.6mm; }
.sv .det { width: 76mm; background: var(--tint); padding: 4mm 5mm 4.2mm; border: 0.25mm solid var(--accent); }
.sv .ttl { font-size: 17pt; letter-spacing: 0.06em; font-weight: 700; color: var(--accent); margin-bottom: 2mm; }
.sv .det table { width: 100%; font-size: 9.4pt; }
.sv .det td { padding: 0.8mm 0; white-space: nowrap; }
.sv .det td.k { color: var(--muted); }
.sv .det td.v { text-align: right; font-weight: 700; }
.sv .card { margin-top: 9mm; border: 0.3mm solid var(--accent); min-height: 70mm; }
.sv .card .hd { display: flex; justify-content: space-between; background: var(--accent); color: #fff; padding: 2.4mm 4.5mm; font-size: 8.6pt; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 700; }
.sv .card .svc { display: flex; justify-content: space-between; align-items: flex-start; gap: 6mm; padding: 4.6mm 4.5mm; border-bottom: 0.25mm dotted #aaa; }
.sv .card .svc .desc b { display: block; font-size: 10.6pt; }
.sv .card .svc .desc span { display: block; color: var(--muted); font-size: 9pt; margin-top: 0.8mm; }
.sv .card .svc .amt { font-weight: 700; font-size: 10.6pt; white-space: nowrap; }
.sv .bottom { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; margin-top: 6mm; }
.sv .remit { flex: 1; font-size: 9pt; }
.sv .remit table td { padding: 0.5mm 0; }
.sv .remit table td.k { color: var(--muted); padding-right: 4mm; white-space: nowrap; }
.sv .remit table td.v { font-weight: 700; white-space: nowrap; }
.sv table.sum { width: 74mm; font-size: 10pt; }
.sv table.sum td { padding: 1.7mm 0; border-bottom: 0.2mm solid #d4d4d4; }
.sv table.sum td.v { text-align: right; white-space: nowrap; font-weight: 600; }
.sv table.sum td.k { color: var(--muted); }
.sv table.sum tr.grand td { border-bottom: 0; border-top: 0.5mm solid var(--accent); padding-top: 2.6mm; font-size: 12pt; font-weight: 700; color: var(--accent-dark); }
.sv .terms { margin-top: 7mm; font-size: 8.8pt; color: var(--muted); }
.sv .foot { position: absolute; left: 15mm; right: 15mm; bottom: 11mm; text-align: center; font-size: 7.8pt; color: var(--muted); border-top: 0.2mm solid #cfcfcf; padding-top: 2.4mm; }
`;

export function renderServices(doc: DocInput): TemplateParts {
  const { data, meta } = doc;
  const b = brandFor(data.vendor_name);
  const vendor = data.vendor_name ?? b.vendor;
  const terms = netTerms(data);
  const date = (iso: string | null) => fmtDate(iso, b.dateStyle);

  const metaRows: string[] = [];
  if (data.invoice_number !== null) metaRows.push(`<tr><td class="k">Invoice No:</td><td class="v">${esc(data.invoice_number)}</td></tr>`);
  if (data.invoice_date !== null) metaRows.push(`<tr><td class="k">Date:</td><td class="v">${date(data.invoice_date)}</td></tr>`);
  if (data.due_date !== null) metaRows.push(`<tr><td class="k">Due date:</td><td class="v">${date(data.due_date)}</td></tr>`);
  if (data.po_reference !== null) metaRows.push(`<tr><td class="k">PO Number:</td><td class="v">${esc(data.po_reference)}</td></tr>`);
  if (terms !== null) metaRows.push(`<tr><td class="k">Terms:</td><td class="v">${esc(terms)}</td></tr>`);
  if (data.currency !== null) metaRows.push(`<tr><td class="k">Currency:</td><td class="v">${esc(data.currency)}</td></tr>`);

  const services = data.line_items
    .map((li) => {
      const rate =
        li.quantity !== null && li.unit_price !== null ? `<span>${qtyText(li.quantity)} &times; ${money(li.unit_price)}</span>` : "";
      return `<div class="svc"><div class="desc"><b>${esc(li.description)}</b>${rate}</div><div class="amt">${money(li.amount)}</div></div>`;
    })
    .join("");

  const totals = totalsRows(data, { subtotal: "Subtotal", tax: "Tax", total: "Total amount due" })
    .map((r) => `<tr class="${r.grand ? "grand" : ""}"><td class="k">${esc(r.label)}</td><td class="v">${r.value}</td></tr>`)
    .join("");

  const bank = bankRows(b, data);
  const remit =
    bank === "" && noticeHtml(data) === ""
      ? `<h4>Remittance</h4><p>Please quote the invoice number with your payment.</p>`
      : `<h4>Remit payment to</h4>${noticeHtml(data)}${bank === "" ? "" : `<table>${bank}</table>`}`;
  const termsLine =
    terms !== null && data.due_date !== null
      ? `Terms: ${esc(terms)}. Payment is due by ${date(data.due_date)}. Thank you for your business.`
      : "Thank you for your business.";

  const body = `
<div class="page sv" style="${brandStyle(b)}">
  <div class="top">
    ${logoMark(b)}
    <div class="bn">${esc(vendor)}</div>
    <div class="tg">${esc(b.tagline)}</div>
    <div class="addr">${b.address.map(esc).join(" &middot; ")}<br>${contactLine(b)}</div>
  </div>
  <div class="rule"></div><div class="rule2"></div>
  <div class="grid">
    <div class="to"><h4>Invoice to</h4>${buyerBlock()}</div>
    <div class="det">
      <div class="ttl">INVOICE</div>
      <table>${metaRows.join("")}</table>
    </div>
  </div>
  <div class="card">
    <div class="hd"><span>Services rendered</span><span>Amount</span></div>
    ${services}
  </div>
  <div class="bottom">
    <div class="remit">${remit}</div>
    <table class="sum">${totals}</table>
  </div>
  <p class="terms">${termsLine}</p>
  <div class="foot">${esc(vendor)} &middot; ${b.address.map(esc).join(", ")} &middot; Page 1 of 1</div>
  ${hiddenHtml(meta)}
</div>`;

  return { title: `Invoice ${data.invoice_number ?? ""} - ${vendor}`.replace(/\s+/g, " ").trim(), css: CSS, body };
}
