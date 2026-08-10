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

/**
 * Deletes the throwaway accounts the e2e suite creates and never cleans up.
 *
 * 02-registration signs up two accounts per run and 13-team-invites one more,
 * all with unique timestamped emails. Nothing removes them: schema.sql and
 * seed-demo.sql are idempotent UPSERTS — they rebuild their own fixtures and
 * never delete a row they did not create — so "reset the database" left every
 * previous run's signups in place. They had reached 52 accounts against 48
 * real fixtures, quietly inflating athlete counts and the admin dashboard's
 * "Registered Athletes" tile.
 *
 * Scoped to the two patterns the specs generate, never a blanket delete, and
 * only reachable here: this script already refuses to run against anything
 * that does not look like a local/test database.
 */
function purgeE2eResidue() {
  process.stdout.write("Purging non-pre-meet residue… ");
  const sql = `
    delete from auth.users
    where email like 'e2e.%'
       or email like 'invitee-%'
       or email like 'e2e.invitee.%'
       -- Superseded quick-login names. seed-demo.sql §5b was realigned to the
       -- athlete-u14/u17/open@ssc.com set that
       -- supabase/seed-production-demo-auth.sql also creates, so one /login
       -- panel is correct on both. An UPSERT seed never deletes what it no
       -- longer creates, so without this the old accounts linger and show up
       -- in the app while being absent from the quick-login list.
       or email in (
            'athlete@ssc.com', 'child-u14@ssc.com',
            'child-multi-u14@ssc.com', 'child-multi-u17@ssc.com',
            'child-multi-open@ssc.com'
          );

    -- Settled payments for a meet that has not happened yet.
    --
    -- seed-demo.sql deletes and rebuilds every entry as pending_payment, but
    -- it does not touch the payment tables — so a previously-confirmed
    -- collection survived the reset and left those swimmers reading "Paid"
    -- on their own dashboard while the very same entries sat in the admin's
    -- cash queue awaiting collection. Money recorded against a meet nobody
    -- has swum is not a pre-meet state.
    delete from public.entry_payment_items;
    delete from public.entry_payments;
    delete from public.relay_squad_payments;
  `;
  const result = spawnSync("psql", [dbUrl!, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.log("\x1b[33mskipped\x1b[0m");
    console.log(`  ${(result.stderr || "").trim()}`);
    return;
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
purgeE2eResidue();

console.log("\n\x1b[32m\x1b[1m✓ test database reset\x1b[0m — fixtures match supabase/seed-demo.sql\n");

/**
 * The standardized convenience logins (supabase/seed-demo.sql §5b), printed
 * so nobody has to open the seed file to find out how to sign in.
 *
 * These sit ALONGSIDE the @ssc-demo.test fixtures the e2e suite pins — those
 * keep their own password, which is why it is spelled out per row rather than
 * announced once for everything.
 */
const ACCOUNTS: [role: string, email: string, note: string][] = [
  ["Admin", "admin@ssc.com", "full admin"],
  ["Referee", "referee@ssc.com", "referee deck"],
  ["Captain", "captain@ssc.com", "captains SSC Demo Club"],
  ["Athlete U14", "athlete-u14@ssc.com", "child of parent@ssc.com"],
  ["Athlete U14 (2nd)", "athlete-u14b@ssc.com", "child of parent-multi@ssc.com"],
  ["Athlete U17", "athlete-u17@ssc.com", "child of parent-multi@ssc.com"],
  ["Athlete Open", "athlete-open@ssc.com", "child of parent-multi@ssc.com"],
  ["Parent", "parent@ssc.com", "1 child: U14"],
  ["Parent (multi)", "parent-multi@ssc.com", "3 children: U14, U17, Open"],
];

const PASSWORD = "password123";
const w = (rows: string[]) => Math.max(...rows.map((r) => r.length));
const roleW = w(ACCOUNTS.map((a) => a[0]).concat("ROLE"));
const mailW = w(ACCOUNTS.map((a) => a[1]).concat("EMAIL"));
const passW = Math.max(PASSWORD.length, "PASSWORD".length);

const line = (l: string, m: string, r: string) =>
  `${l}${"─".repeat(roleW + 2)}${m}${"─".repeat(mailW + 2)}${m}${"─".repeat(passW + 2)}${m}${"─".repeat(30)}${r}`;

console.log("\x1b[1mStandardized test logins\x1b[0m");
console.log(line("┌", "┬", "┐"));
console.log(
  `│ \x1b[1m${"ROLE".padEnd(roleW)}\x1b[0m │ \x1b[1m${"EMAIL".padEnd(mailW)}\x1b[0m │ ` +
    `\x1b[1m${"PASSWORD".padEnd(passW)}\x1b[0m │ \x1b[1m${"NOTE".padEnd(28)}\x1b[0m │`,
);
console.log(line("├", "┼", "┤"));
for (const [role, email, note] of ACCOUNTS) {
  console.log(
    `│ ${role.padEnd(roleW)} │ ${email.padEnd(mailW)} │ ${PASSWORD.padEnd(passW)} │ ${note.padEnd(28)} │`,
  );
}
console.log(line("└", "┴", "┘"));
console.log(
  "\n\x1b[2mThe e2e fixtures (@ssc-demo.test, password Password123!) are unchanged —\n" +
    "see supabase/SEED_CREDENTIALS.md.\x1b[0m\n",
);
