import { test, expect, type Locator, type Page } from "@playwright/test";
import { CREDENTIALS, login, logout, requireFixture } from "./helpers";
import { createRefereeHeatFixture, type HeatFixture } from "./fixtures/heat-fixture";

/**
 * These specs run against a SHARED database.
 *
 * Reaching for "the first heat in the deck" was really asserting on whatever
 * the previous run left behind: a card another test had already submitted or
 * published renders a different set of buttons, so the suite failed for
 * reasons unrelated to the code under test. Every test that scores a heat now
 * creates the heat it needs, works only on that one, and deletes it after.
 */

/** Scrolls the fixture's own card into view and returns it. */
async function openFixtureCard(page: Page, fixture: HeatFixture): Promise<Locator> {
  await page.goto("/referee");
  const card = page.getByTestId(`heat-card-${fixture.heatId}`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

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

    // The filter bar always renders. Heat cards only appear once heats
    // exist — they are generated when an admin confirms entries, so on a
    // freshly-seeded database there are legitimately none yet.
    await expect(page.getByText("Filter the deck")).toBeVisible();
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });

  test("referee enters a valid time, saves progress, and it persists after reload", async ({ page }) => {
    const fixture = await createRefereeHeatFixture();
    requireFixture(fixture !== null, "an event with entries to build a scratch heat from");
    if (!fixture) return;

    try {
      await login(page, CREDENTIALS.referee1);
      const card = await openFixtureCard(page, fixture);

      await card.getByRole("button", { name: "Valid Time" }).first().click();
      await card.locator('input[id^="time-"]').first().fill("00:29.87");

      // Partial save: one of two lanes is scored, so this is Save Progress.
      await card.getByRole("button", { name: /Save Progress/ }).click();
      await expect(
        page.getByRole("heading", { name: /Heat card submitted|Progress saved/ }),
      ).toBeVisible({ timeout: 8_000 });

      await page.reload();
      const reloaded = page.getByTestId(`heat-card-${fixture.heatId}`);
      await expect(reloaded).toBeVisible({ timeout: 20_000 });
      await expect(reloaded.locator('input[id^="time-"]').first()).toHaveValue("29.87");
    } finally {
      await fixture.cleanup();
    }
  });

  test("a submitted card locks itself until Edit Heat Card is chosen", async ({ page }) => {
    const fixture = await createRefereeHeatFixture();
    requireFixture(fixture !== null, "an event with entries to build a scratch heat from");
    if (!fixture) return;

    try {
      await login(page, CREDENTIALS.referee1);
      const card = await openFixtureCard(page, fixture);

      // Score every lane so the card is complete and can be submitted.
      const validButtons = card.getByRole("button", { name: "Valid Time" });
      const laneCount = await validButtons.count();
      for (let i = 0; i < laneCount; i += 1) {
        await validButtons.nth(i).click();
        await card.locator('input[id^="time-"]').nth(i).fill(`00:3${i}.10`);
      }

      await card.getByRole("button", { name: /Submit Heat Card to Admin/ }).click();
      await expect(page.getByRole("heading", { name: /Heat card submitted/ })).toBeVisible({
        timeout: 8_000,
      });

      // Submitted: the card presents as sent, and editing is a deliberate act.
      await expect(card.getByRole("button", { name: "Edit Heat Card" })).toBeVisible();
      await expect(card.locator('input[id^="time-"]').first()).toBeDisabled();

      // Choosing Edit unlocks the lanes again.
      await card.getByRole("button", { name: "Edit Heat Card" }).click();
      await expect(card.locator('input[id^="time-"]').first()).toBeEnabled();
      await expect(card.getByRole("button", { name: /Re-submit Heat Card to Admin/ })).toBeVisible();
    } finally {
      await fixture.cleanup();
    }
  });

  test("a published card is read-only for a referee, with an explicit disabled state", async ({
    page,
  }) => {
    const fixture = await createRefereeHeatFixture();
    requireFixture(fixture !== null, "an event with entries to build a scratch heat from");
    if (!fixture) return;

    try {
      // Referee scores and submits it.
      await login(page, CREDENTIALS.referee1);
      const card = await openFixtureCard(page, fixture);
      const validButtons = card.getByRole("button", { name: "Valid Time" });
      const laneCount = await validButtons.count();
      for (let i = 0; i < laneCount; i += 1) {
        await validButtons.nth(i).click();
        await card.locator('input[id^="time-"]').nth(i).fill(`00:2${i}.55`);
      }
      await card.getByRole("button", { name: /Submit Heat Card to Admin/ }).click();
      await expect(page.getByRole("heading", { name: /Heat card submitted/ })).toBeVisible({
        timeout: 8_000,
      });

      // Admin publishes it. Clearing the session first matters: signing in
      // over a live one leaves the form spinning and never navigates.
      await logout(page);
      await login(page, CREDENTIALS.admin);
      await page.goto("/admin");
      await page.getByRole("button", { name: /Referee Heat Cards/ }).click();
      await page.waitForTimeout(2500);

      const queued = page
        .locator('[data-testid="review-heat-card"]')
        .filter({ hasText: `Heat ${fixture.heatNumber}` })
        .first();
      await expect(queued).toBeVisible({ timeout: 15_000 });
      await queued.getByRole("button", { name: /Publish Heat Card/ }).click();
      await page.waitForTimeout(2500);

      // Back as the referee: published is read-only, and says so.
      await logout(page);
      await login(page, CREDENTIALS.referee1);
      const published = await openFixtureCard(page, fixture);
      const locked = published.getByRole("button", {
        name: /Submitted — Contact Admin to Edit/,
      });
      await expect(locked).toBeVisible();
      await expect(locked).toBeDisabled();
      await expect(published.getByRole("button", { name: "Edit Heat Card" })).toHaveCount(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("invalid clock time text is flagged inline, blocking a bad save", async ({ page }) => {
    const fixture = await createRefereeHeatFixture();
    requireFixture(fixture !== null, "an event with entries to build a scratch heat from");
    if (!fixture) return;

    try {
      await login(page, CREDENTIALS.referee1);
      const card = await openFixtureCard(page, fixture);
      await card.getByRole("button", { name: "Valid Time" }).first().click();
      const timeInput = card.locator('input[id^="time-"]').first();
      await timeInput.fill("garbage");
      await expect(timeInput).toHaveAttribute("aria-invalid", "true");
    } finally {
      await fixture.cleanup();
    }
  });

  test("a referee never sees a direct 'Publish' action — only Save Progress / Submit to Admin", async ({
    page,
  }) => {
    await login(page, CREDENTIALS.referee1);
    await page.goto("/referee");
    await page.waitForTimeout(1500);

    await expect(page.getByRole("button", { name: /^Publish/ })).toHaveCount(0);
    await expect(page.getByText(/Chief Referee|Observer|Lane \d Lock/i)).toHaveCount(0);
  });

  test("two devices on the same Referee account see each other's saved draft live", async ({
    browser,
  }) => {
    // A single dedicated Referee account (seed-demo.sql scope lock) — this
    // simulates the same referee with a phone AND a tablet open at once,
    // proving the sync is a genuine postgres_changes subscription rather
    // than per-session local state, without needing a second seeded user.
    const fixture = await createRefereeHeatFixture();
    requireFixture(fixture !== null, "an event with entries to build a scratch heat from");
    if (!fixture) return;

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await login(pageA, CREDENTIALS.referee1);
      await login(pageB, CREDENTIALS.referee1);
      const cardA = await openFixtureCard(pageA, fixture);
      const cardB = await openFixtureCard(pageB, fixture);

      // B's postgres_changes channel has to reach SUBSCRIBED before A writes:
      // an event published into the gap is not replayed, and the test would
      // fail for a timing reason rather than a broken subscription.
      await pageB.waitForTimeout(3000);

      await cardA.getByRole("button", { name: "Valid Time" }).first().click();
      await cardA.locator('input[id^="time-"]').first().fill("00:31.42");
      // Two lanes, one scored — a partial save, so the label is Save Progress.
      await cardA.getByRole("button", { name: /Save Progress/ }).click();
      await pageA.waitForTimeout(1500);

      // B never touched anything — a live postgres_changes subscription,
      // not a local optimistic update, must be what surfaces A's save.
      await expect(cardB.locator('input[id^="time-"]').first()).toHaveValue("31.42", {
        timeout: 15_000,
      });
    } finally {
      await fixture.cleanup();
      await ctxA.close();
      await ctxB.close();
    }
  });
});
