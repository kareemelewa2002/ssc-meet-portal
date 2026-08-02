import { test, type Page } from "@playwright/test";

/**
 * Strict mode — set SSC_E2E_STRICT=1 after `npm run db:reset:test` so that a
 * missing fixture FAILS instead of skipping.
 *
 * Skips are indistinguishable from passes in CI, which is how this suite
 * stayed green through a total heats/heat_lanes outage. Every remaining
 * fixture guard therefore routes through requireFixture() below: it skips
 * with an actionable message on a drifted local database, but hard-fails once
 * the run claims to be against freshly-seeded data.
 */
export const STRICT_FIXTURES = process.env.SSC_E2E_STRICT === "1";

/** Asserts a seeded fixture exists. Hard-fails under SSC_E2E_STRICT=1. */
export function requireFixture(present: boolean, what: string) {
  if (present) return;
  if (STRICT_FIXTURES) {
    throw new Error(
      `Missing seeded fixture: ${what}. The database has drifted from supabase/seed-demo.sql — run \`npm run db:reset:test\`.`,
    );
  }
  test.skip(
    true,
    `${what} is missing — run \`npm run db:reset:test\` (or set SSC_E2E_STRICT=1 to fail instead of skip).`,
  );
}

/** Every account in supabase/seed-demo.sql shares this password. */
export const SEED_PASSWORD = "Password123!";

// Scope-locked to exactly 5 roles: admin, referee, coach, athlete, parent.
// The Referee role is fully consolidated (attendance + time entry, one
// account, no lane-claim/Chief tier) — there is no usher, entry_helper, or
// chief_referee anymore.
export const CREDENTIALS = {
  admin: "elewakareem2002@gmail.com",
  // A single dedicated Referee account — seed-demo.sql no longer seeds a
  // pool of interchangeable referees.
  referee1: "referee1@ssc-demo.test",
  coachRiptide: "coach.riptide@ssc-demo.test",
  coachMarlins: "coach.marlins@ssc-demo.test",
  // The only seeded athlete with team_id = NULL. Every other athlete is on
  // a team, and the transfer lock blocks their join requests while a volume
  // is 'scheduled' — so this is the only account that can exercise the
  // join-request happy path.
  unattached: "athlete39@ssc-demo.test",
  parent1: "parent1@ssc-demo.test",
  approvedU14: "athlete01@ssc-demo.test",
  approvedU17: "athlete13@ssc-demo.test",
  approvedOpen: "athlete25@ssc-demo.test",
  unapproved: "athlete37@ssc-demo.test",
  pendingParentLinkage: "athlete38@ssc-demo.test",
  cashPending: "athlete02@ssc-demo.test",
} as const;

/** Logs in via the real /login form and waits for the post-login redirect. */
export async function login(page: Page, email: string, password: string = SEED_PASSWORD) {
  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== "/login", { timeout: 15_000 });
}

/**
 * Login that reports failure instead of throwing — for fixture accounts that
 * may not exist on a database which has drifted from seed-demo.sql. Pair with
 * requireFixture() so a missing account skips with an actionable message
 * (or hard-fails under SSC_E2E_STRICT=1) rather than dying on a timeout.
 */
export async function tryLogin(
  page: Page,
  email: string,
  password: string = SEED_PASSWORD,
): Promise<boolean> {
  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.locator('button[type="submit"]').click();
  try {
    await page.waitForURL((url) => url.pathname !== "/login", { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function logout(page: Page) {
  const trigger = page.locator('header button:has([data-slot="avatar"])').first();
  if (await trigger.count()) {
    await trigger.click();
    await page.getByText("Sign Out").click();
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 10_000 });
  } else {
    await page.context().clearCookies();
  }
}
