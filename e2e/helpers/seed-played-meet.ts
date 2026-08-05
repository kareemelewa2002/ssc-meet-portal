/**
 * Advances the fresh pre-meet seed into a playable meet-in-progress state.
 *
 * supabase/seed-demo.sql deliberately leaves every entry as pending_payment
 * with no heats or results. Downstream Playwright specs need the opposite:
 * confirmed payments (so heats exist), published Freestyle times (so Skins
 * qualifiers and career ledgers exist), and scored Round-of-6 Skins boards.
 *
 * Applied after scripts/reset-test-db.ts from e2e/global-setup.ts. Uses a
 * direct Postgres connection (SUPABASE_DB_URL) — the anon key cannot run the
 * admin-gated status transitions or materialise_skins_heat as a batch job.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SQL = join(ROOT, "e2e", "helpers", "seed-played-meet.sql");

function fail(message: string, detail?: string): never {
  console.error(`\n\x1b[31m✗ seed-played-meet: ${message}\x1b[0m`);
  if (detail) console.error(detail.slice(0, 2000));
  console.error("");
  process.exit(1);
}

/** Confirms payments, scores Freestyle sample results, publishes Skins Round of 6. */
export function seedPlayedMeet(dbUrl: string = process.env.SUPABASE_DB_URL ?? ""): void {
  if (!dbUrl) {
    fail(
      "SUPABASE_DB_URL is not set.",
      "  Point it at the same disposable instance as NEXT_PUBLIC_SUPABASE_URL.",
    );
  }
  if (!existsSync(SQL)) fail(`missing ${SQL}`);

  process.stdout.write("Seeding played-meet state… ");
  const res = spawnSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "--quiet", "-f", SQL], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.log("");
    fail("SQL failed", res.stderr || res.stdout || "");
  }
  console.log("\x1b[32mok\x1b[0m");
}
