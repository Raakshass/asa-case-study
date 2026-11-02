/**
 * Guardrail + PDF checks, no LLM (IMPLEMENTATION_PLAN.md Phase 4, docs/CONTRACTS.md section 6).
 * OWNER: Phase 4. Replace this placeholder with the Phase 4 asserts: injection scan flags #9 only, tiny/hidden
 * text flags #9 only, grounding of the fooled #9 extraction (PO-1003 / 400) fails while the truth passes,
 * "400" does not ground against "4,400.00", a 1pt "PO-1003 400.00" does not ground, validateUpload rejects a
 * .txt renamed .pdf, an empty file, a > 10 MB buffer, a > 5 page PDF and a truncated PDF, and HOLDs
 * data/fixtures/encrypted.pdf with "Password-protected PDF, request an unlocked copy".
 */
import type { Check } from "./harness";

export async function run(t: Check): Promise<void> {
  t.skip("guardrails on the sample PDFs", "placeholder: Phase 4 implements scripts/checks/guardrails.ts");
}
