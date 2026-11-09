import { BadgeCheck, Building2, Calculator, ClipboardList, CopyCheck, FileCheck2, Gavel, Scale, ScanText, ShieldAlert, type LucideIcon } from "lucide-react";
import type { StageKey } from "@/lib/types";

/**
 * Each of the 10 checks as a plain question, an icon, and what it catches, for people who do not read "normalize" or
 * "grounding": the pipeline map, the stepper and the How it works page all use these. Not a client module (no
 * "use client"), so server pages can use the values too.
 */
export const STAGE_PLAIN: Readonly<Record<StageKey, { question: string; catches: string; Icon: LucideIcon }>> = {
  ingest: { question: "Is it a real PDF we have not seen?", catches: "Files that are not PDFs, broken or locked PDFs, oversized files, and the exact same file sent twice.", Icon: FileCheck2 },
  screen: { question: "Is anything hidden or trying to instruct the AI?", catches: "Hidden text and instructions planted in the invoice for the AI to follow, found before any AI reads it.", Icon: ShieldAlert },
  extract: { question: "What does the invoice say?", catches: "The AI reads the vendor, numbers, dates, line items, bank details and PO reference into a fixed form. It reads; it never decides.", Icon: ScanText },
  validate: { question: "Do the numbers add up and match the page?", catches: "Totals that do not add up, low-confidence readings, missing invoice numbers, documents that are not invoices, and values that are not printed on the page.", Icon: Calculator },
  normalize: { question: "Which vendor is it, in our records?", catches: "Name variants and legal suffixes (\"Globex Logistics\" vs \"Globex Logistics Ltd\"), date formats and invoice-number formatting.", Icon: Building2 },
  vendor: { question: "Is the vendor approved, with the bank details on file?", catches: "Unknown or unapproved vendors, look-alike names, and new or changed bank accounts (a classic payment fraud).", Icon: BadgeCheck },
  po_match: { question: "Which purchase order does it bill?", catches: "Missing, unknown, closed or another vendor's POs. With no PO printed, it narrows the candidates and asks a person to confirm.", Icon: ClipboardList },
  amounts: { question: "Is it within the PO's balance and prices?", catches: "Billing over what is left on a PO (including a PO split across several invoices), prices above the PO, and items the PO never ordered, with a 2% tolerance.", Icon: Scale },
  duplicate: { question: "Have we paid this before?", catches: "The same invoice re-sent with different formatting or look-alike characters, and the same amount from the same vendor within a week.", Icon: CopyCheck },
  decide: { question: "Approve, hold or reject?", catches: "Combines every check: any reject wins, then any hold; otherwise approve. A security flag can never be approved. It also writes the next action.", Icon: Gavel },
};
