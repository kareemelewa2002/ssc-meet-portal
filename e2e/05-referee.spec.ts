import { test, expect } from "@playwright/test";
import { CREDENTIALS, login } from "./helpers";

test.describe("Consolidated Referee deck", () => {
  test("loads with session/event/heat picker, attendance board, and time entry — no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await login(page, CREDENTIALS.referee1);
    await page.goto("/referee");
    await page.waitForTimeout(1500);

    await expect(page.getByText("Session, event & heat")).toBeVisible();
    await expect(page.getByText("Call-room attendance")).toBeVisible();
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });

  test("referee can mark a lane Present, then Absent (call-room attendance, no separate usher role)", async ({ page }) => {
    await login(page, CREDENTIALS.referee1);
    await page.goto("/referee");
    await page.waitForTimeout(1500);

    const presentButtons = page.getByRole("button", { name: "Present" });
    test.skip(!(await presentButtons.count()), "No lanes seeded for the default heat.");

    // This suite runs repeatedly against the same live, persistent
    // heat_lanes rows (no reset between runs), so lane 1's starting
    // attendance_status isn't guaranteed to be "pending" — assert the
    // summary badge's text genuinely CHANGES on each click rather than
    // assuming a fixed before/after count.
    const summaryBadge = page.getByText(/\d+\/\d+ present/);
    const before = await summaryBadge.innerText();
    await presentButtons.first().click();
    await page.waitForTimeout(800);
    await expect(summaryBadge).not.toHaveText(before);

    const afterPresent = await summaryBadge.innerText();
    const absentButtons = page.getByRole("button", { name: "Absent" });
    await absentButtons.first().click();
    await page.waitForTimeout(800);
    // Toggling to Absent moves that lane out of "present" — the summary
    // must change again, not stay stuck (no usher write-lockdown quirks
    // now that the referee owns attendance directly).
    await expect(summaryBadge).not.toHaveText(afterPresent);
  });

  test("referee enters a valid time, saves progress, and it persists after reload", async ({ page }) => {
    await login(page, CREDENTIALS.referee1);
    await page.goto("/referee");
    await page.waitForTimeout(1500);

    const validButtons = page.getByRole("button", { name: "Valid Time" });
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

    await page.getByRole("button", { name: "Valid Time" }).first().click();
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

  test("two referees viewing the same default heat see each other's saved draft live", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await login(pageA, CREDENTIALS.referee1);
      await login(pageB, CREDENTIALS.referee2);
      await pageA.goto("/referee");
      await pageB.goto("/referee");
      await pageA.waitForTimeout(1500);
      await pageB.waitForTimeout(1500);

      const validButtonsA = pageA.getByRole("button", { name: "Valid Time" });
      test.skip(!(await validButtonsA.count()), "No lanes seeded for the default heat.");
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
