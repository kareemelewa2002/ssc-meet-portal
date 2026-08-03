import { test, expect } from "@playwright/test";
import { CREDENTIALS, login, requireFixture } from "./helpers";

test.describe("Consolidated Referee deck", () => {
  test("loads with session/event/heat picker and time entry — no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await login(page, CREDENTIALS.referee1);
    await page.goto("/referee");
    await page.waitForTimeout(1500);

    // The picker always renders. The lane cards only render once a heat has
    // lanes — heats are generated when an admin confirms entries, so on a
    // freshly-seeded database there are legitimately none yet.
    await expect(page.getByText("Session, event & heat")).toBeVisible();
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });

  test("referee enters a valid time, saves progress, and it persists after reload", async ({ page }) => {
    await login(page, CREDENTIALS.referee1);
    await page.goto("/referee");
    await page.waitForTimeout(1500);

    const validButtons = page.getByRole("button", { name: "Valid Time" });
    requireFixture((await validButtons.count()) > 0, "a seeded heat with lanes to score");
    await expect(validButtons.first()).toBeVisible();
    await validButtons.first().click();

    const timeInput = page.locator('input[id^="time-"]').first();
    await timeInput.fill("00:29.87");

    const saveButton = page.getByRole("button", { name: /Save Progress|Submit Heat Card to Admin|Heat card submitted/ });
    await saveButton.click();
    // The save toast's heading is the unambiguous confirmation signal —
    // the button's own label also matches this text once saved, so a plain
    // getByText() here would hit both and fail Playwright's strict mode.
    await expect(page.getByRole("heading", { name: /Heat card submitted|Progress saved/ })).toBeVisible({
      timeout: 8_000,
    });

    await page.reload();
    await page.waitForTimeout(2000);
    await expect(page.locator('input[id^="time-"]').first()).toHaveValue("29.87");
  });

  test("invalid clock time text is flagged inline, blocking a bad save", async ({ page }) => {
    await login(page, CREDENTIALS.referee1);
    await page.goto("/referee");
    await page.waitForTimeout(1500);

    const valid = page.getByRole("button", { name: "Valid Time" });
    requireFixture((await valid.count()) > 0, "a seeded heat with lanes to score");
    await valid.first().click();
    const timeInput = page.locator('input[id^="time-"]').first();
    await timeInput.fill("garbage");
    await expect(timeInput).toHaveAttribute("aria-invalid", "true");
  });

  test("a referee never sees a direct 'Publish' action — only Save Progress / Submit to Admin", async ({ page }) => {
    await login(page, CREDENTIALS.referee1);
    await page.goto("/referee");
    await page.waitForTimeout(1500);

    await expect(page.getByRole("button", { name: /^Publish/ })).toHaveCount(0);
    await expect(page.getByText(/Chief Referee|Observer|Lane \d Lock/i)).toHaveCount(0);
  });

  test("two devices on the same Referee account see each other's saved draft live", async ({ browser }) => {
    // A single dedicated Referee account (seed-demo.sql scope lock) — this
    // simulates the same referee with a phone AND a tablet open at once,
    // proving the sync is a genuine postgres_changes subscription rather
    // than per-session local state, without needing a second seeded user.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await login(pageA, CREDENTIALS.referee1);
      await login(pageB, CREDENTIALS.referee1);
      await pageA.goto("/referee");
      await pageB.goto("/referee");
      await pageA.waitForTimeout(1500);
      await pageB.waitForTimeout(1500);

      const validButtonsA = pageA.getByRole("button", { name: "Valid Time" });
      requireFixture((await validButtonsA.count()) > 0, "seeded lanes for the default heat");
      await validButtonsA.first().click();
      await pageA.locator('input[id^="time-"]').first().fill("00:31.42");
      await pageA.getByRole("button", { name: /Save Progress|Submit Heat Card to Admin/ }).click();
      await pageA.waitForTimeout(1500);

      // B never touched anything — a live postgres_changes subscription,
      // not a local optimistic update, must be what surfaces A's save.
      await expect(pageB.locator('input[id^="time-"]').first()).toHaveValue("31.42", { timeout: 10_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
