/**
 * npx tsx scripts/seed.ts
 * Creates the tables in $DATA_DIR/app.db and loads data/seed/*.json (vendors, POs, history), replacing all
 * demo state (idempotent). Exits 1 with a clear message, touching nothing, when the seed data is missing or
 * invalid (Phase 1 writes it; shapes in docs/CONTRACTS.md section 3). Do not run it while the dev server
 * is processing a run. Owner: contracts step.
 */
import path from "node:path";
import { loadEnvForScripts, paths } from "../src/lib/config";
import { openDb } from "../src/lib/db";
import { SeedDataError, readSeedFiles, seedFromData } from "../src/lib/seed";

async function main(): Promise<number> {
  loadEnvForScripts();
  let data;
  try {
    data = readSeedFiles(paths.seedDir);
  } catch (e) {
    if (e instanceof SeedDataError) {
      console.error(`seed: ${e.message}`);
      return 1;
    }
    throw e;
  }
  const db = openDb(paths.dbFile);
  try {
    const counts = seedFromData(db, data);
    console.log(`Seeded ${path.relative(process.cwd(), paths.dbFile) || paths.dbFile}`);
    console.table(counts);
    return 0;
  } finally {
    db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
