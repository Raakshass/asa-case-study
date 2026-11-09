/**
 * npx tsx scripts/check-static.ts
 *
 * Static audits of the source tree and of the production client bundle (run it after `npm run build`; the bundle
 * audits FAIL when .next/static is missing). Exit code 1 on any failure.
 *
 *   1. No `dangerouslySetInnerHTML` and no `NEXT_PUBLIC_` anywhere under src/ (plan section 6, Phase 7).
 *   2. Client code only reaches src/lib through types.ts and format.ts (docs/CONTRACTS.md section 7): every file
 *      with "use client" and everything it imports under src/, transitively, is client code; such files may import
 *      from src/lib only types.ts and format.ts, the src/lib files those pull in may not import Node built-ins or
 *      server-only packages, and no client file may import them either.
 *   3. The production client bundle (.next/static) contains no "OPENROUTER", no "NVIDIA_API_KEY", no "better-sqlite3" and none of the
 *      file-system / database code of src/lib (markers below). A positive control checks the same markers DO occur
 *      in the server build, so a marker that never matches anything cannot make this pass by accident.
 *   4. No source file outside src/lib/extract.ts reads a provider key: OPENROUTER_API_KEY, its numbered extras
 *      (OPENROUTER_API_KEY2.., _2..) or NVIDIA_API_KEY (src/ and scripts/; writing or deleting them, as
 *      scripts/test-extract.ts does, is not a read).
 *   4b. Automations never write the decision tables (Automations plan D3): no statement in the automations code
 *      inserts, updates or deletes runs, run_steps, invoices, purchase_orders, vendors or run_reviews, and it imports
 *      neither the review module, insertInvoice, seedDatabase/seedFromData nor (other than as a type) the pipeline.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const LIB = path.join(SRC, "lib");
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");

let failures = 0;
function report(ok: boolean, name: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
}

function walk(dir: string, keep: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, keep));
    else if (entry.isFile() && keep(full)) out.push(full);
  }
  return out;
}
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/* ---- 1. banned strings ------------------------------------------------------------------------- */

function bannedStrings(): void {
  const hits: string[] = [];
  for (const file of walk(SRC, () => true)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/dangerouslySetInnerHTML|NEXT_PUBLIC_/.test(line)) hits.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  report(hits.length === 0, "no dangerouslySetInnerHTML and no NEXT_PUBLIC_ under src/", hits.join("\n        "));
}

/* ---- 2. what client code can reach in src/lib --------------------------------------------------- */

const IMPORT_RES = [
  /\bimport\s+(?:type\s+)?[^'"`;]*?\sfrom\s*["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^'"`;]*?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];
/** Packages and built-ins that must never reach the browser. */
const SERVER_ONLY = /^(node:|fs$|fs\/|path$|crypto$|os$|child_process$|worker_threads$|stream$|zlib$|better-sqlite3$|unpdf$|pdf-lib$)/;

/** Value imports of a file (a whole-statement `import type` / `export type` is erased by the compiler, so it is skipped). */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const re of IMPORT_RES) {
    for (const m of text.matchAll(re)) {
      if (/^\s*(import|export)\s+type\s/.test(m[0])) continue;
      out.push(m[1]);
    }
  }
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const isClientEntry = (file: string): boolean => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/.test(fs.readFileSync(file, "utf8"));

function clientBoundary(): void {
  const entries = walk(SRC, (f) => /\.(ts|tsx)$/.test(f)).filter(isClientEntry);
  report(entries.length > 0, `found the "use client" files (${entries.length})`);
  const seen = new Set<string>();
  const queue = [...entries];
  const libDirect = new Map<string, Set<string>>(); // src/lib file -> client files outside src/lib that import it
  const serverImports: string[] = [];
  const unresolved: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (SERVER_ONLY.test(spec)) {
        serverImports.push(`${rel(file)} imports ${spec}`);
        continue;
      }
      const target = resolveLocal(file, spec);
      if (target === null) {
        if (spec.startsWith("@/") || spec.startsWith(".")) unresolved.push(`${rel(file)}: ${spec}`);
        continue; // an npm package (react, lucide-react, ...)
      }
      if (target.startsWith(LIB + path.sep) && !file.startsWith(LIB + path.sep)) {
        const set = libDirect.get(target) ?? new Set<string>();
        set.add(rel(file));
        libDirect.set(target, set);
      }
      queue.push(target);
    }
  }
  const allowed = new Set([path.join(LIB, "types.ts"), path.join(LIB, "format.ts"), path.join(LIB, "workflow-graph.ts")]);
  const bad = [...libDirect.entries()].filter(([lib]) => !allowed.has(lib)).map(([lib, by]) => `${rel(lib)} (imported by ${[...by].join(", ")})`);
  report(bad.length === 0, `client code imports from src/lib only types.ts, format.ts and workflow-graph.ts (${[...libDirect.keys()].map(rel).join(", ") || "none"})`, bad.join("\n        "));
  const libReached = [...seen].filter((f) => f.startsWith(LIB + path.sep)).map(rel).sort();
  report(serverImports.length === 0, `no client file, and no src/lib file they pull in (${libReached.join(", ")}), imports a Node built-in or a server-only package`, serverImports.join("\n        "));
  report(unresolved.length === 0, `every local import of the client graph resolves (${seen.size} files checked)`, unresolved.join("\n        "));
}

/* ---- 3. the production client bundle ----------------------------------------------------------- */

/** Strings that only server code of this repo (or a server-only package) contains. */
const MARKERS: [string, RegExp][] = [
  ["OPENROUTER", /OPENROUTER/i],
  ["NVIDIA_API_KEY", /NVIDIA_API_KEY/],
  ["better-sqlite3", /better-sqlite3/],
  ["SQLite schema (db.ts)", /CREATE TABLE IF NOT EXISTS/],
  ["SQLite pragmas (db.ts)", /journal_mode|busy_timeout/],
  ["the upload worker (pdf.ts)", /pdf-text-worker/],
  ["Node file-system calls", /\b(readFileSync|writeFileSync|mkdirSync|readdirSync|createReadStream|statSync)\b/],
  ["Node built-in imports", /["']node:(fs|path|crypto|os|child_process|worker_threads)["']/],
  ["the env loader (config.ts)", /loadEnvForScripts|\.env\.local/],
  ["startup recovery text (db.ts)", /Interrupted by restart, please re-run/],
];

function bundle(): void {
  const staticDir = path.join(ROOT, ".next", "static");
  const files = walk(staticDir, (f) => /\.(js|mjs|css|json|txt)$/.test(f));
  const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  report(files.length > 0 && bytes > 100_000, `the production client bundle exists (${files.length} files, ${Math.round(bytes / 1024)} KB in .next/static)`, files.length === 0 ? "run `npm run build` first" : "");
  const texts = files.map((f) => [f, fs.readFileSync(f, "utf8")] as const);
  for (const [name, re] of MARKERS) {
    const where = texts.filter(([, t]) => re.test(t)).map(([f]) => rel(f));
    report(where.length === 0, `client bundle: no ${name}`, where.join(", "));
  }
  // positive control: the same markers do occur in the server build (so the patterns can match at all)
  const serverFiles = walk(path.join(ROOT, ".next", "server"), (f) => f.endsWith(".js"));
  const serverText = serverFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const control = ["SQLite schema (db.ts)", "SQLite pragmas (db.ts)", "the upload worker (pdf.ts)", "OPENROUTER", "startup recovery text (db.ts)"];
  const missing = control.filter((name) => !(MARKERS.find(([n]) => n === name)?.[1] as RegExp).test(serverText));
  report(serverFiles.length > 0 && missing.length === 0, `control: the server build does contain the server markers (${control.length} checked in ${serverFiles.length} files)`, missing.join(", "));
}

/* ---- 4. who reads the provider keys --------------------------------------------------------------- */

function keyReads(): void {
  const files = [...walk(SRC, (f) => CODE_RE.test(f)), ...walk(path.join(ROOT, "scripts"), (f) => CODE_RE.test(f))];
  const reads: string[] = [];
  let inExtract = 0;
  const access = /process\.env(?:\.(?:OPENROUTER_API_KEY\w*|NVIDIA_API_KEY)\b|\[\s*["'`](?:OPENROUTER_API_KEY\w*|NVIDIA_API_KEY)["'`]\s*\])/g;
  for (const file of files) {
    if (path.resolve(file) === path.resolve(__filename)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(access)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 10), m.index);
      const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 4);
      const write = /^\s*=(?!=)/.test(after) || /delete\s+$/.test(before);
      if (write) continue;
      if (rel(file) === "src/lib/extract.ts") inExtract++;
      else reads.push(`${rel(file)}: ${text.slice(m.index, (m.index ?? 0) + 60).split("\n")[0]}`);
    }
    if (/\{[^}]*\b(?:OPENROUTER_API_KEY\w*|NVIDIA_API_KEY)\b[^}]*\}\s*=\s*process\.env/.test(text) && rel(file) !== "src/lib/extract.ts") reads.push(`${rel(file)}: destructures one from process.env`);
  }
  report(reads.length === 0, `no file outside src/lib/extract.ts reads a provider key (OPENROUTER_API_KEY*, NVIDIA_API_KEY; ${files.length} files under src/ and scripts/)`, reads.join("\n        "));
  report(inExtract >= 1, `control: src/lib/extract.ts does read them (${inExtract} direct read)`);
}

/* ---- 4b. automations never write the decision tables (D3) ---------------------------------------- */

/** A statement that writes a decision table: plain, quoted and main.-qualified names. */
const DECISION_WRITE = /\b(INSERT(\s+OR\s+\w+)?\s+INTO|UPDATE(\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+(main\.)?["'`\[]?(runs|run_steps|invoices|purchase_orders|vendors|run_reviews)\b/i;
/** Names automations code must never import (they write invoices or wipe everything), and modules it may not import at all. */
const FORBIDDEN_NAMES = /\b(insertInvoice|seedDatabase|seedFromData)\b/;
const IMPORT_STATEMENT = /\bimport\s+(type\s+)?([^;]*?)\sfrom\s*["']([^"']+)["']/g;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** What is wrong with one source text, as short sentences (empty when it is fine). Pure, so the control below can test it. */
function automationFindings(source: string): string[] {
  const text = stripComments(source);
  const found: string[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (DECISION_WRITE.test(line)) found.push(`line ${i + 1}: writes a decision table: ${line.trim().slice(0, 80)}`);
  }
  // an SQL string may span lines: test the whole text too, with whitespace collapsed
  if (found.length === 0 && DECISION_WRITE.test(text.replace(/\s+/g, " "))) found.push("writes a decision table (statement spans lines)");
  for (const m of text.matchAll(IMPORT_STATEMENT)) {
    const typeOnly = m[1] !== undefined;
    const spec = m[3];
    if (/(^|\/)review$/.test(spec)) found.push(`imports the review module (${spec})`);
    if (!typeOnly && /(^|\/)pipeline$/.test(spec)) found.push(`imports the pipeline other than as a type (${spec})`);
    if (FORBIDDEN_NAMES.test(m[2])) found.push(`imports ${m[2].trim().slice(0, 60)} from ${spec}`);
  }
  return found;
}

function automationsGuard(): void {
  const files = [
    ...walk(path.join(LIB, "automations"), (f) => CODE_RE.test(f)),
    ...walk(path.join(SRC, "app", "api", "automations"), (f) => CODE_RE.test(f)),
    ...walk(path.join(SRC, "app", "api", "runs", "[id]", "automations"), (f) => CODE_RE.test(f)),
    ...["automation-views.ts"].map((n) => path.join(SRC, "app", "api", "_lib", n)).filter((f) => fs.existsSync(f)),
  ];
  const hits: string[] = [];
  for (const file of files) for (const f of automationFindings(fs.readFileSync(file, "utf8"))) hits.push(`${rel(file)}: ${f}`);
  report(hits.length === 0, `automations never write the decision tables (D3) (${files.length} files)`, hits.join("\n        "));
  // control: the rule really matches what it is meant to catch, and lets the automations' own tables through
  const caught = [
    'db.exec("UPDATE runs SET decision = \'APPROVE\'")',
    'db.prepare("DELETE FROM main.invoices")',
    'db.prepare(`insert or replace into "vendors" values (1)`)',
    'db.exec("INSERT INTO run_reviews (id) VALUES (1)")',
    'import { reviewRun } from "../review";',
    'import { runExclusive } from "../pipeline";',
    'import { seedDatabase } from "../seed";',
    'import { insertInvoice, x } from "../master";',
  ];
  const allowed = [
    'db.prepare("UPDATE run_notes SET text = ?")',
    'db.prepare("INSERT INTO workflow_executions (id) VALUES (?)")',
    'db.prepare("DELETE FROM workflows WHERE id = ?")',
    'import type { PipelineDeps } from "../pipeline";',
    'import { poBalance, loadSnapshot } from "../master";',
  ];
  const missed = caught.filter((c) => automationFindings(c).length === 0);
  const wrong = allowed.filter((c) => automationFindings(c).length > 0);
  report(missed.length === 0 && wrong.length === 0, "control: the rule catches decision-table writes and forbidden imports and passes the automations' own tables", [...missed.map((m) => `not caught: ${m}`), ...wrong.map((w) => `wrongly caught: ${w}`)].join("\n        "));
}

function main(): number {
  console.log("check-static: source and bundle audits");
  bannedStrings();
  clientBoundary();
  bundle();
  keyReads();
  automationsGuard();
  console.log(failures === 0 ? "\nAll static checks passed." : `\n${failures} static check(s) FAILED.`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
