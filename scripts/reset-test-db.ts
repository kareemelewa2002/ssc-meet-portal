#!/usr/bin/env node
/**
 * Re-applies supabase/seed-demo.sql so the E2E suite runs against a known,
 * deterministic fixture set.
 *
 * WHY THIS EXISTS
 * ---------------
 * Playwright specs were littered with `test.skip(...)` guards whose reason was
 * always some variant of "the live database has drifted from seed-demo.sql".
 * A skip is indistinguishable from a pass in CI, so those guards quietly
 * removed real coverage — and the suite still reported green through a total
 * heats/heat_lanes outage. Deterministic state is what lets those guards
 * become hard assertions.
 *
 * SAFETY
 * ------
 * seed-demo.sql is destructive: it deletes and rebuilds heats/lanes/results
 * for Vol. 1 and upserts every demo account. It must therefore NEVER run
 * against production. This script refuses to run unless SUPABASE_DB_URL is
 * set explicitly, and additionally refuses any URL that isn't clearly a
 * test/local target unless ALLOW_NON_TEST_DB=1 is also set.
 *
 * SETUP
 * -----
 * Supabase → Project Settings → Database → Connection string (URI):
 *
 *   export SUPABASE_DB_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'
 *   npm run db:reset:test
 *
 * The anon key in .env.local CANNOT do this — PostgREST exposes no DDL and no
 * arbitrary SQL, so a direct Postgres connection is required.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SEED = join(ROOT, "supabase", "seed-demo.sql");
const SCHEMA = join(ROOT, "supabase", "schema.sql");

function fail(message: string, hint?: string): never {
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m`);
  if (hint) console.error(hint);
  console.error("");
  process.exit(1);
}

function looksLikeTestTarget(url: string): boolean {
  return /localhost|127\.0\.0\.1|host\.docker\.internal|(-|_|\b)(test|staging|dev)(-|_|\b)/i.test(url);
}

const dbUrl = process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  fail(
    "SUPABASE_DB_URL is not set — cannot reset the test database.",
    [
      "",
      "  This script needs a DIRECT PostgreSQL connection. The NEXT_PUBLIC anon",
      "  key in .env.local cannot apply SQL: PostgREST exposes no DDL surface.",
      "",
      "  Supabase → Project Settings → Database → Connection string (URI):",
      "",
      "    export SUPABASE_DB_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'",
      "    npm run db:reset:test",
      "",
      "  Point this at a DEDICATED test project, never production — seed-demo.sql",
      "  rebuilds heats/lanes/results and upserts every demo account.",
    ].join("\n"),
  );
}

if (!looksLikeTestTarget(dbUrl) && process.env.ALLOW_NON_TEST_DB !== "1") {
  fail(
    "SUPABASE_DB_URL does not look like a test/local database — refusing to run.",
    [
      "",
      "  seed-demo.sql is destructive (rebuilds Vol. 1 heats/lanes/results and",
      "  upserts all demo accounts). Running it against production would wipe",
      "  real meet data.",
      "",
      "  If this really is a disposable test project, re-run with:",
      "",
      "    ALLOW_NON_TEST_DB=1 npm run db:reset:test",
    ].join("\n"),
  );
}

for (const file of [SCHEMA, SEED]) {
  if (!existsSync(file)) fail(`Missing ${file}`);
}

try {
  execFileSync("psql", ["--version"], { stdio: "ignore" });
} catch {
  fail(
    "'psql' not found on PATH.",
    "  Install PostgreSQL client tools (e.g. brew install postgresql@14).",
  );
}

function apply(label: string, file: string) {
  process.stdout.write(`Applying ${label}… `);
  const res = spawnSync("psql", [dbUrl!, "-v", "ON_ERROR_STOP=1", "--quiet", "-f", file], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.log("");
    fail(`${label} failed`, (res.stderr || res.stdout || "").slice(0, 2000));
  }
  console.log("\x1b[32mok\x1b[0m");
}

const host = (() => {
  try {
    return new URL(dbUrl).host;
  } catch {
    return "(unparsed host)";
  }
})();

console.log(`\n\x1b[1mResetting test database\x1b[0m → ${host}\n`);

// schema.sql first: it is idempotent and guarantees the seed lands on the
// current shape (the 'usher' outage came from exactly this drift).
apply("schema.sql", SCHEMA);
apply("seed-demo.sql", SEED);

console.log("\n\x1b[32m\x1b[1m✓ test database reset\x1b[0m — fixtures match supabase/seed-demo.sql\n");
