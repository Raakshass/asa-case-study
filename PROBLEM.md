# PS-1 · FINANCE / AP — Invoice processing: from PDF to decision

A mid-size company receives hundreds of vendor invoices every month — all by email, all as PDFs.
Someone on the AP team opens each one, finds the matching purchase order in a spreadsheet, checks
whether the numbers line up, and decides what to do with it. It's repetitive, it's slow, and it's the kind of
work where a tired person on a Friday afternoon makes expensive mistakes.

The invoices themselves are messy. Different vendors format them differently. Some are clean PDFs with
machine-readable text. Some are scanned images. Line items might be itemised or bundled. Tax might be
embedded or separated. PO references might be explicit or implied. And sometimes critical information is
just missing — no invoice number, no date, no clear total.

On the other side is a procurement system with its own logic — approved vendors, PO amounts, tolerance
thresholds, duplicate detection rules. Matching an invoice to a PO isn't always obvious. A vendor might
split a single PO into multiple invoices. Amounts might be close but not exact. The process has to make a
decision — and be able to explain it.

Build a process that takes an invoice as input and produces a clear, reasoned decision as output — with
everything that happened in between visible. You decide what to extract, how to validate, what rules
matter, and what the output looks like.

## EDGE CASES — YOU DEFINE THEM

Design and build 2–4 edge cases of your own. They should be realistic scenarios where the process has
to behave differently from the happy path — situations that reveal how flexible and deliberate your logic
is. Don't pick trivial ones. The edge cases you choose tell us how well you understand the problem.
