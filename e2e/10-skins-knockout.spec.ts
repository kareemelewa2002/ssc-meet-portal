import { test, expect, type Page } from "@playwright/test";
import { CREDENTIALS, login, requireFixture } from "./helpers";

/**
 * End-to-end cover for the Skins knockout.
 *
 * The regression that matters most is the first test: a Skins board is
 * (age category x gender), but heat_group folds 17 & Under in with Open, so
 * whichever of those two boards was opened SECOND used to collide on
 * heat_lanes (heat_id, lane_number) and fail with "duplicate key value
 * violates unique constraint". Opening both in one run is the whole point.
 */

const OPEN_MEN = /Open Men/;
const U17_MEN = /17 & Under Men/;

async function openSkinsTab(page: Page) {
  await page.goto("/referee");
  await page.getByRole("button", { name: "Skins knockout" }).click();
  // The bracket materialises its opening round on mount.
  await page.waitForTimeout(2500);
}

/** Scores every lane of the first unscored round card, then submits it. */
async function scoreAndSubmitRound(page: Page) {
  const card = page.locator('[data-testid="skins-round-card"]').first();
  await expect(card).toBeVisible();

  const laneRows = card.locator('[data-testid="skins-lane-row"]');
  const count = await laneRows.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    const row = laneRows.nth(i);
    // Place buttons are labelled 1..n; give lane i finishing place i+1 so the
    // round has a clean, tie-free result.
    await row.getByRole("button", { name: String(i + 1), exact: true }).click();
  }

  await card.getByRole("button", { name: /Send (corrected )?round to admin|Send corrected round/ }).click();
  await expect(card.getByText("Awaiting admin")).toBeVisible({ timeout: 10_000 });
  return count;
}

test.describe("Skins knockout", () => {
  test("both 17 & Under and Open boards of one gender open without colliding", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await login(page, CREDENTIALS.referee1);
    await openSkinsTab(page);

    const openBtn = page.getByRole("button", { name: OPEN_MEN });
    const u17Btn = page.getByRole("button", { name: U17_MEN });
    requireFixture(
      (await openBtn.count()) > 0 && (await u17Btn.count()) > 0,
      "Skins qualifiers on both the Open Men and 17 & Under Men boards",
    );

    // Open Men first, then 17 & Under Men. Under the old schema the second of
    // these failed outright: both resolved to the same heat row.
    await openBtn.click();
    await page.waitForTimeout(2500);
    await expect(page.locator('[data-testid="skins-lane-row"]').first()).toBeVisible();

    await u17Btn.click();
    await page.waitForTimeout(2500);
    await expect(page.locator('[data-testid="skins-lane-row"]').first()).toBeVisible();

    // The specific failure this replaces.
    await expect(page.getByText(/duplicate key value/i)).toHaveCount(0);
    await expect(page.getByText(/Couldn.t load the Skins heat/i)).toHaveCount(0);
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });

  test("referee scores a round, admin publishes it, and it locks", async ({ page }) => {
    await login(page, CREDENTIALS.referee1);
    await openSkinsTab(page);

    const openBtn = page.getByRole("button", { name: OPEN_MEN });
    requireFixture((await openBtn.count()) > 0, "Skins qualifiers on the Open Men board");
    await openBtn.click();
    await page.waitForTimeout(2500);

    const firstCard = page.locator('[data-testid="skins-round-card"]').first();
    const alreadyPublished = await firstCard.getByText("Published").count();
    test.skip(alreadyPublished > 0, "This board's opening round is already published.");

    await scoreAndSubmitRound(page);

    // Referee cannot publish — only send. The publish control lives on Admin.
    await expect(firstCard.getByRole("button", { name: /Publish/ })).toHaveCount(0);

    // Admin approves it.
    await login(page, CREDENTIALS.admin);
    await page.goto("/admin");
    // The tab button renders a short and a long label, so its accessible
    // name is "Skins Skins Approvals" — match the long one.
    await page.getByRole("button", { name: /Skins Approvals/ }).click();
    await page.waitForTimeout(2500);

    const adminRound = page
      .locator('[data-testid="skins-approval-round"]')
      .filter({ hasText: "Round of 6" })
      .filter({ hasText: "Open Men" })
      .first();
    await expect(adminRound).toBeVisible({ timeout: 10_000 });
    await adminRound.getByRole("button", { name: /Publish .*this round/ }).click();

    // Published once, and it says so rather than offering a second publish.
    await expect(adminRound.getByText("Published")).toBeVisible({ timeout: 10_000 });
    await expect(adminRound.getByRole("button", { name: /Reopen to correct/ })).toBeVisible();
    await expect(adminRound.getByRole("button", { name: /Publish .*this round/ })).toHaveCount(0);

    // And the referee sees it locked.
    await login(page, CREDENTIALS.referee1);
    await openSkinsTab(page);
    await page.getByRole("button", { name: OPEN_MEN }).click();
    await page.waitForTimeout(2500);
    const locked = page.locator('[data-testid="skins-round-card"]').first();
    await expect(locked.getByText("Published")).toBeVisible();
    await expect(locked.getByText(/An admin must reopen this round/)).toBeVisible();
  });

  test("advancing re-seeds the survivors into the centred lanes", async ({ page }) => {
    await login(page, CREDENTIALS.referee1);
    await openSkinsTab(page);

    const openBtn = page.getByRole("button", { name: OPEN_MEN });
    requireFixture((await openBtn.count()) > 0, "Skins qualifiers on the Open Men board");
    await openBtn.click();
    await page.waitForTimeout(2500);

    const advance = page.getByRole("button", { name: /Set up Round of 4/ });
    requireFixture(
      (await advance.count()) > 0,
      "a scored Round of 6 on the Open Men board (run the scoring test first)",
    );
    await advance.click();
    await page.waitForTimeout(3000);

    const roundOfFour = page
      .locator('[data-testid="skins-round-card"]')
      .filter({ hasText: "Round of 4" })
      .first();
    await expect(roundOfFour).toBeVisible({ timeout: 10_000 });

    // Four survivors swim down the middle of the pool: lanes 2-5, never 1 or 6.
    const lanes = await roundOfFour.locator('[data-testid="skins-lane-number"]').allInnerTexts();
    expect(lanes).toEqual(["L2", "L3", "L4", "L5"]);

    // The Round of 6 must still be intact — publishing/advancing used to
    // overwrite it, because every round shared one heat.
    const roundOfSix = page
      .locator('[data-testid="skins-round-card"]')
      .filter({ hasText: "Round of 6" })
      .first();
    await expect(roundOfSix).toBeVisible();
    await expect(roundOfSix.locator('[data-testid="skins-lane-row"]')).toHaveCount(6);
  });
});
