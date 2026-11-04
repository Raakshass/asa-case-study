/**
 * Next.js instrumentation hook: runs once when the server process starts. It opens the database so startup
 * recovery (runs left queued or running by a restart become "error") and first-time seeding happen at boot, not
 * on the first request. A failure is logged (error name only) and does not stop the server: the handlers retry
 * getDb() and answer 500 until the cause is fixed.
 *
 * Node.js runtime only. The import sits INSIDE a positive `NEXT_RUNTIME === "nodejs"` test: Next compiles this file
 * for the Edge runtime too, and only that form lets webpack drop the branch (and with it better-sqlite3, which cannot
 * be bundled for the Edge) before it resolves the import; an early `return` does not. `next build` never opens the
 * database either.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    try {
      const { getDb } = await import("./lib/db");
      const db = getDb();
      const count = (table: "vendors" | "runs"): number => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
      console.log(JSON.stringify({ event: "startup", db: "ready", vendors: count("vendors"), runs: count("runs") }));
      // Scheduled automations (logs nothing; a no-op when automations are off or AUTOMATION_SCHEDULER=off)
      const { startScheduler } = await import("./lib/automations/schedule");
      startScheduler();
    } catch (e) {
      const raw = e instanceof Error ? e.name : "Error";
      console.error(JSON.stringify({ event: "startup", db: "failed", error: raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) }));
    }
  }
}
