import { test, expect } from "@playwright/test";

/**
 * Part 3 §1 — Unauthenticated Guest & Route Guard Suite.
 * Every test in this file starts with a clean, cookie-less context (the
 * Playwright default), so each `page.goto` genuinely exercises the guest
 * path through middleware.ts.
 */

const PROTECTED_ROUTES = [
  "/athletes",
  "/teams",
  "/leaderboards/all-time",
  "/referee",
  "/admin",
  "/admin/seeding",
  "/dashboard",
];

test.describe("Guest route guard", () => {
  test("bare / redirects a guest straight to /login with no redirectTo", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL("**/login");
    expect(new URL(page.url()).searchParams.get("redirectTo")).toBeNull();
  });

  for (const route of PROTECTED_ROUTES) {
    test(`${route} redirects a guest to /login?redirectTo=${encodeURIComponent(route)}`, async ({ page }) => {
      await page.goto(route);
      await page.waitForURL("**/login**");
      const url = new URL(page.url());
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("redirectTo")).toBe(route);
    });
  }

  test("/login is reachable with no session", async ({ page }) => {
    const response = await page.goto("/login");
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator("#login-email")).toBeVisible();
  });

  test("/register is reachable with no session", async ({ page }) => {
    const response = await page.goto("/register");
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator("#email")).toBeVisible();
  });
});
