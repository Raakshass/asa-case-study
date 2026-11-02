/**
 * Business-rule checks, no LLM (IMPLEMENTATION_PLAN.md Phase 3, docs/CONTRACTS.md section 6).
 * OWNER: Phase 3. Replace this placeholder: for each truth sample (samples.ts loadTruthSamples), on a fresh
 * openSeededMemoryDb(), run checkExtract (on an ok ExtractResult built from the truth) -> checkValidate ->
 * normalizeInvoice/checkNormalize -> checkVendor -> checkPoMatch (deterministic fake SuggestPoFn) ->
 * checkAmounts -> checkDuplicate -> decide -> nextAction with now = FIXED_NOW, and assert _meta
 * expectedDecision, expectedReasonIncludes, expectedNextActionIncludes, expectedSecurityFlag, expectedPo
 * and expectedSteps; plus the invariant "securityFlag => never APPROVE".
 */
import type { Check } from "./harness";

export async function run(t: Check): Promise<void> {
  t.skip("business rules on the 10 truth samples", "placeholder: Phase 3 implements scripts/checks/business.ts");
}
