import type { Page } from "@playwright/test";

/** Every account in supabase/seed-demo.sql shares this password. */
export const SEED_PASSWORD = "Password123!";

// Scope-locked to exactly 5 roles: admin, referee, coach, athlete, parent.
// The Referee role is fully consolidated (attendance + time entry, one
// account, no lane-claim/Chief tier) — there is no usher, entry_helper, or
// chief_referee anymore.
export const CREDENTIALS = {
  admin: "elewakareem2002@gmail.com",
  referee1: "referee1@ssc-demo.test",
  referee2: "referee2@ssc-demo.test",
  coachRiptide: "coach.riptide@ssc-demo.test",
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
