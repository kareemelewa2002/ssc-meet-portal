import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { seedPlayedMeet } from "./helpers/seed-played-meet";

/**
 * Resets the E2E database to supabase/seed-demo.sql before the suite runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The suite ran against a SHARED database, so every run consumed fixtures the
 * next one needed: pending teams got approved, cash payments confirmed,
 * entries filled the 4-event cap, Skins rounds published. `requireFixture`
 * turned each of those into a skip, and the skip count climbed run over run
 * (6 -> 8 -> 10) while the suite still reported green. A skip is
 * indistinguishable from a pass, so coverage was quietly draining away.
 *
 * SAFETY — READ BEFORE CHANGING
 * -----------------------------
 * seed-demo.sql is DESTRUCTIVE: it rebuilds Vol. 1 heats/lanes/results and
 * upserts every demo account. Two independent mistakes have to be impossible:
 *
 *   1. Wiping the real project. Guarded by scripts/reset-test-db.ts, which
 *      refuses any URL that does not look like a test/local target unless
 *      ALLOW_NON_TEST_DB=1.
 *
 *   2. Resetting one database while testing another — "isolation" that
 *      isolates nothing. The app under test connects via
 *      NEXT_PUBLIC_SUPABASE_URL; the reset writes to SUPABASE_DB_URL. If those
 *      are different instances, the suite exercises data this setup never
 *      touched, and a green run means nothing. assertSameInstance() below is
 *      the check, and it is the reason this file exists rather than a bare
 *      call to the reset script.
 */

const ROOT = process.cwd();

function fail(message: string, hint?: string): never {
  console.error(`\n\x1b[31m✗ E2E setup: ${message}\x1b[0m`);
  if (hint) console.error(hint);
  console.error("");
  process.exit(1);
}

/**
 * Identifies the Supabase instance behind a URL.
 *
 * Cloud projects are `https://<ref>.supabase.co` and
 * `postgresql://postgres:pw@db.<ref>.supabase.co:5432/postgres`, so the
 * project ref is the shared identity. Anything on loopback is "local",
 * regardless of port — the API and Postgres listen on different ones.
 */
export function instanceIdentity(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)$/i.test(host)) return "local";
  const ref = host.match(/^(?:db\.)?([a-z0-9]+)\.supabase\.(?:co|in)$/i);
  return ref ? ref[1].toLowerCase() : host.toLowerCase();
}

function assertSameInstance(appUrl: string, dbUrl: string) {
  const app = instanceIdentity(appUrl);
  const db = instanceIdentity(dbUrl);
  if (!app || !db) {
    fail(
      "could not identify the Supabase instance from the configured URLs.",
      `  NEXT_PUBLIC_SUPABASE_URL=${appUrl}\n  SUPABASE_DB_URL host=${dbUrl.replace(/:[^:@/]*@/, ":****@")}`,
    );
  }
  if (app !== db) {
    fail(
      "the app and the reset target are DIFFERENT databases — refusing to run.",
      [
        "",
        `  The app under test would talk to : ${app}`,
        `  The reset would rebuild          : ${db}`,
        "",
        "  Resetting one database while testing another is not isolation: the",
        "  specs would run against data this setup never touched, and a green",
        "  run would prove nothing.",
        "",
        "  Point NEXT_PUBLIC_SUPABASE_URL and SUPABASE_DB_URL at the SAME",
        "  disposable instance (see .env.test.example).",
      ].join("\n"),
    );
  }
}

export default async function globalSetup() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  const appUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!appUrl) fail("NEXT_PUBLIC_SUPABASE_URL is not set — the app has nothing to talk to.");

  if (!dbUrl) {
    fail(
      "SUPABASE_DB_URL is not set, so the database cannot be reset.",
      [
        "",
        "  Without a reset the suite runs on whatever the last run left behind:",
        "  fixtures get consumed, specs skip, and the skip count grows silently.",
        "",
        "  Create a DISPOSABLE Supabase instance and point both variables at it:",
        "",
        "    cp .env.test.example .env.test    # then fill it in",
        "",
        "  Local (needs Docker + the Supabase CLI):",
        "",
        "    supabase start                    # prints the URL, anon key and DB URL",
        "",
        "  To deliberately run WITHOUT a reset (fixtures may be stale, and specs",
        "  will fail rather than skip under SSC_E2E_STRICT=1):",
        "",
        "    SSC_E2E_SKIP_RESET=1 npx playwright test",
      ].join("\n"),
    );
  }

  assertSameInstance(appUrl, dbUrl);

  const script = join(ROOT, "scripts", "reset-test-db.ts");
  if (!existsSync(script)) fail(`missing ${script}`);

  console.log("\n\x1b[1mE2E global setup\x1b[0m — resetting the test database…");
  const res = spawnSync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script],
    { stdio: "inherit", env: process.env },
  );
  if (res.status !== 0) {
    fail(
      "the database reset failed — aborting before any spec runs.",
      "  A suite started on an unknown fixture state is worse than no suite:\n" +
        "  its skips and failures would describe the database, not the code.",
    );
  }

  // seed-demo.sql stops at pending_payment with zero heats. Downstream specs
  // need confirmed payments, Freestyle results, and Skins Round-of-6 boards.
  console.log("\x1b[1mE2E global setup\x1b[0m — advancing to played-meet state…");
  seedPlayedMeet(dbUrl);
}
