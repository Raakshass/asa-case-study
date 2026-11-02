/**
 * Minimal test harness for scripts/check.ts (no test framework, no network, no clock).
 * A group module exports `async function run(t: Check)`; inside it, call `await t.test(name, fn)`.
 * Assertions throw; a failing test is recorded and the group continues with the next test.
 * Owner: contracts step (docs/CONTRACTS.md section 6).
 */
import { inspect, isDeepStrictEqual } from "node:util";
import { openDb, type DB } from "../../src/lib/db";
import { seedDatabase } from "../../src/lib/seed";

/** The fixed "today" every check uses (sample invoices are dated late October 2026). */
export const FIXED_NOW = new Date("2026-11-02T12:00:00.000Z");

export class CheckFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckFailure";
  }
}

export interface TestOptions {
  /** default 20 s */
  timeoutMs?: number;
}

export interface Check {
  /** name of the running group */
  readonly group: string;
  /** Runs one test; never throws (failures are recorded). Always await it. */
  test(name: string, fn: () => void | Promise<void>, opts?: TestOptions): Promise<void>;
  /** Records a skipped test (e.g. Phase 1 data not written yet). */
  skip(name: string, reason: string): void;
  ok(cond: unknown, msg?: string): asserts cond;
  /** deep strict equality (node:util isDeepStrictEqual) */
  eq(actual: unknown, expected: unknown, msg?: string): void;
  /** string: case-insensitive substring. array: some element contains it (case-insensitive). */
  includes(haystack: string | readonly string[] | null | undefined, needle: string, msg?: string): void;
  /** |actual - expected| <= tol (default 0.005) */
  approx(actual: number | null | undefined, expected: number, tol?: number, msg?: string): void;
  /** fn (sync or async) must throw; match tests the error message */
  throws(fn: () => unknown, match?: RegExp | string, msg?: string): Promise<void>;
  fail(msg: string): never;
}

export interface CheckResult {
  group: string;
  name: string;
  status: "pass" | "fail" | "skip";
  ms: number;
  message?: string;
}

export interface Harness {
  readonly results: CheckResult[];
  /** Runs a group body; an exception outside t.test (e.g. a broken import) is recorded as a failure. */
  group(name: string, body: (t: Check) => Promise<void>): Promise<void>;
  /** Prints the summary table and failures; returns the number of failures. */
  summary(): number;
}

const show = (v: unknown) => inspect(v, { depth: 6, breakLength: 120, maxStringLength: 300 });

function describeError(e: unknown): string {
  if (e instanceof CheckFailure) return e.message;
  if (e instanceof Error) {
    const at = e.stack?.split("\n").find((l) => l.trim().startsWith("at "))?.trim() ?? "";
    return `threw ${e.name}: ${e.message}${at ? ` (${at})` : ""}`;
  }
  return `threw ${show(e)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckFailure(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function createHarness(opts: { grep?: string } = {}): Harness {
  const results: CheckResult[] = [];
  const grep = opts.grep?.toLowerCase();

  const record = (r: CheckResult) => {
    results.push(r);
    const tag = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
    const note = r.status === "pass" ? ` (${r.ms} ms)` : r.message ? `: ${r.message.split("\n")[0]}` : "";
    console.log(`  ${tag}  ${r.group} > ${r.name}${note}`);
  };

  const makeCheck = (group: string): Check => ({
    group,
    async test(name, fn, testOpts) {
      if (grep && !name.toLowerCase().includes(grep)) return;
      const started = Date.now();
      try {
        await withTimeout(Promise.resolve().then(fn), testOpts?.timeoutMs ?? 20_000);
        record({ group, name, status: "pass", ms: Date.now() - started });
      } catch (e) {
        record({ group, name, status: "fail", ms: Date.now() - started, message: describeError(e) });
      }
    },
    skip(name, reason) {
      if (grep && !name.toLowerCase().includes(grep)) return;
      record({ group, name, status: "skip", ms: 0, message: reason });
    },
    ok(cond, msg) {
      if (!cond) throw new CheckFailure(msg ?? `expected a truthy value, got ${show(cond)}`);
    },
    eq(actual, expected, msg) {
      if (!isDeepStrictEqual(actual, expected)) {
        throw new CheckFailure(`${msg ? `${msg}: ` : ""}expected ${show(expected)}, got ${show(actual)}`);
      }
    },
    includes(haystack, needle, msg) {
      const n = needle.toLowerCase();
      const hit =
        typeof haystack === "string"
          ? haystack.toLowerCase().includes(n)
          : Array.isArray(haystack) && haystack.some((s) => String(s).toLowerCase().includes(n));
      if (!hit) throw new CheckFailure(`${msg ? `${msg}: ` : ""}expected ${show(haystack)} to include ${show(needle)}`);
    },
    approx(actual, expected, tol = 0.005, msg) {
      if (typeof actual !== "number" || !(Math.abs(actual - expected) <= tol)) {
        throw new CheckFailure(`${msg ? `${msg}: ` : ""}expected ${expected} (+-${tol}), got ${show(actual)}`);
      }
    },
    async throws(fn, match, msg) {
      let threw = false;
      try {
        await fn();
      } catch (e) {
        threw = true;
        const text = e instanceof Error ? e.message : String(e);
        const okMatch = match === undefined || (typeof match === "string" ? text.includes(match) : match.test(text));
        if (!okMatch) throw new CheckFailure(`${msg ? `${msg}: ` : ""}error ${show(text)} does not match ${show(match)}`);
      }
      if (!threw) throw new CheckFailure(`${msg ? `${msg}: ` : ""}expected an error`);
    },
    fail(msg) {
      throw new CheckFailure(msg);
    },
  });

  return {
    results,
    async group(name, body) {
      console.log(`\n${name}`);
      const started = Date.now();
      try {
        await body(makeCheck(name));
      } catch (e) {
        record({ group: name, name: "(group setup)", status: "fail", ms: Date.now() - started, message: describeError(e) });
      }
    },
    summary() {
      const groups = [...new Set(results.map((r) => r.group))];
      const rows = groups.map((g) => {
        const rs = results.filter((r) => r.group === g);
        const n = (s: CheckResult["status"]) => rs.filter((r) => r.status === s).length;
        return { group: g, pass: n("pass"), fail: n("fail"), skip: n("skip") };
      });
      const failures = results.filter((r) => r.status === "fail");
      const pad = (s: string | number, w: number) => String(s).padEnd(w);
      console.log(`\n${pad("group", 14)}${pad("pass", 6)}${pad("fail", 6)}skip`);
      for (const r of rows) console.log(`${pad(r.group, 14)}${pad(r.pass, 6)}${pad(r.fail, 6)}${r.skip}`);
      if (failures.length > 0) {
        console.log(`\n${failures.length} failing:`);
        for (const f of failures) console.log(`- ${f.group} > ${f.name}\n    ${(f.message ?? "").replace(/\n/g, "\n    ")}`);
      }
      console.log(failures.length === 0 ? "\nAll checks passed." : "\nChecks FAILED.");
      return failures.length;
    },
  };
}

/**
 * A fresh ':memory:' database seeded from data/seed (Phase 1's files). Throws SeedDataError when the seed
 * data is missing or invalid (callers usually t.skip in that case). Close it when done.
 */
export function openSeededMemoryDb(seedDir?: string): DB {
  const db = openDb(":memory:");
  try {
    seedDatabase(db, seedDir);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
