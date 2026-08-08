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
  // domcontentloaded: realtime subscriptions keep networkidle from settling.
  await page.goto("/referee", { waitUntil: "domcontentloaded" });
  const card = page.getByTestId(`heat-card-${fixture.heatId}`);
  await expect(card).toBeVisible({ timeout: 45_000 });
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
      await card.locator('input[id^="time-"]').first().fill("29.87");

      // Partial save: one of two lanes is scored, so this is Save Progress.
      const save = card.getByRole("button", { name: /Save Progress/ });
      await expect(save).toBeEnabled({ timeout: 5_000 });
      await save.click();
      await expect(
        page.getByRole("heading", { name: /Heat card submitted|Progress saved/ }),
      ).toBeVisible({ timeout: 20_000 });

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
        await card.locator('input[id^="time-"]').nth(i).fill(`3${i}.10`);
      }

      await card.getByRole("button", { name: /Submit Heat Card to Admin/ }).click();
      await expect(page.getByRole("heading", { name: /Heat card submitted/ })).toBeVisible({
        timeout: 20_000,
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
        await card.locator('input[id^="time-"]').nth(i).fill(`2${i}.55`);
      }
      await card.getByRole("button", { name: /Submit Heat Card to Admin/ }).click();
      await expect(page.getByRole("heading", { name: /Heat card submitted/ })).toBeVisible({
        timeout: 20_000,
      });

      // Admin publishes it. Clearing the session first matters: signing in
      // over a live one leaves the form spinning and never navigates.
      await logout(page);
      await login(page, CREDENTIALS.admin);
      await page.goto("/admin");
      await page.getByRole("button", { name: /Referee Heat Cards/ }).click();
      await page.waitForTimeout(2500);

      // Addressed by heat id, not by "Heat {n}": heat numbers restart per age
      // board and per gender, so a text match can select a different card
      // entirely — and .first() would then publish the wrong heat and leave
      // this fixture merely submitted, failing the referee-side assertion
      // below for a reason that has nothing to do with the code under test.
      const queued = page.locator(
        `[data-testid="review-heat-card"][data-heat-id="${fixture.heatId}"]`,
      );
      await expect(queued).toBeVisible({ timeout: 15_000 });
      await queued.getByRole("button", { name: /Publish Heat Card/ }).click();
      // Asserted, not slept on: switching back to the referee before the
      // publish lands tests an unpublished card and fails misleadingly.
      await expect(queued.getByText("Published", { exact: true })).toBeVisible({
        timeout: 20_000,
      });

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

  test("a bad clock time cannot be entered, and an impossible one is flagged", async ({ page }) => {
    // This used to type "garbage" and assert aria-invalid. The mm:ss.cc input
    // mask now strips non-digits as they arrive, so letters never reach the
    // field at all — a STRONGER guarantee than flagging them, but it does mean
    // the old assertion could no longer fire. Both halves are asserted here so
    // the protection the original test existed for is not quietly lost:
    //   1. letters are unenterable, so a bad save is impossible;
    //   2. a time that is numerically reachable but impossible is still
    //      flagged inline — 77.77 seconds, which the mask will happily
    //      assemble from four digits but no clock can show.
    const fixture = await createRefereeHeatFixture();
    requireFixture(fixture !== null, "an event with entries to build a scratch heat from");
    if (!fixture) return;

    try {
      await login(page, CREDENTIALS.referee1);
      const card = await openFixtureCard(page, fixture);
      await card.getByRole("button", { name: "Valid Time" }).first().click();
      const timeInput = card.locator('input[id^="time-"]').first();

      await timeInput.pressSequentially("garbage");
      await expect(timeInput).toHaveValue("");

      // Four digits mask to "77.77" — seconds only go to 59.
      await timeInput.pressSequentially("7777");
      await expect(timeInput).toHaveValue("77.77");
      await expect(timeInput).toHaveAttribute("aria-invalid", "true");

      // And the mask really is assembling the separators from bare digits.
      await timeInput.fill("");
      await timeInput.pressSequentially("10543");
      await expect(timeInput).toHaveValue("1:05.43");
      await expect(timeInput).not.toHaveAttribute("aria-invalid", "true");
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
    // Two browser contexts, two full sign-ins, and a deliberate 3s wait for
    // the realtime channel to reach SUBSCRIBED — this one sits right on the
    // 90s default and tips over it on a slower run. The waits are what make it
    // trustworthy (see the SUBSCRIBED note below), so the budget gives way,
    // not the waits.
    test.slow();

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
      // fail for a timing reason rather than a broken subscription. This was
      // a blind 3s sleep, which is either too long or — on a cold start,
      // which is exactly when it matters — not long enough. The card now
      // reports its own channel state, so this waits for the real signal.
      await expect(cardB).toHaveAttribute("data-realtime", "subscribed", { timeout: 30_000 });

      await cardA.getByRole("button", { name: "Valid Time" }).first().click();
      await cardA.locator('input[id^="time-"]').first().fill("31.42");
      // Two lanes, one scored — a partial save, so the label is Save Progress.
      const saveA = cardA.getByRole("button", { name: /Save Progress/ });
      await expect(saveA).toBeEnabled({ timeout: 5_000 });
      await saveA.click();
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
