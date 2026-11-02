/**
 * npx tsx scripts/check.ts [group ...] [--grep=text]
 * Runs every check group with no LLM, no network and a fixed clock (harness FIXED_NOW):
 *   contracts  - shared modules and data shapes (contracts step)
 *   business   - normalize + rules on the truth samples (Phase 3)
 *   guardrails - pdf + guardrails on the sample PDFs (Phase 4)
 * Each group module is imported on demand, so a broken group fails alone instead of crashing the run.
 * Exit code 1 if any check fails. Owner: contracts step.
 */
import { type Check, createHarness } from "./checks/harness";

type GroupModule = { run: (t: Check) => Promise<void> };

const GROUPS: Record<string, () => Promise<GroupModule>> = {
  contracts: () => import("./checks/contracts"),
  business: () => import("./checks/business"),
  guardrails: () => import("./checks/guardrails"),
};

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const grep = args.find((a) => a.startsWith("--grep="))?.slice("--grep=".length);
  const selected = args.filter((a) => !a.startsWith("--"));
  const unknown = selected.filter((g) => !(g in GROUPS));
  if (unknown.length > 0) {
    console.error(`Unknown group(s): ${unknown.join(", ")}. Groups: ${Object.keys(GROUPS).join(", ")}`);
    return 2;
  }
  const harness = createHarness({ grep });
  for (const [name, load] of Object.entries(GROUPS)) {
    if (selected.length > 0 && !selected.includes(name)) continue;
    await harness.group(name, async (t) => (await load()).run(t));
  }
  return harness.summary() > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
    // Exit even if a check leaked a handle (open server, interval); unref so a clean run exits at once.
    setTimeout(() => process.exit(code), 200).unref();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
