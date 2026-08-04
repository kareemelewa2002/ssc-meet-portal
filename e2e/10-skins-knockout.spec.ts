import { test, expect, type Page } from "@playwright/test";
import { CREDENTIALS, login, logout, requireFixture } from "./helpers";

/**
 * End-to-end cover for the Skins knockout.
 *
 * The regression that matters most is the first test: a Skins board is
 * (age category x gender), but heat_group folds 17 & Under in with Open, so
 * whichever of those two boards was materialised SECOND used to collide on
 * heat_lanes (heat_id, lane_number) and fail with "duplicate key value
 * violates unique constraint". Every board appearing in one deck is the check.
 *
 * Skins is listed in the referee deck and the admin heat-card queue with every
 * other race, so these drive the same screens an official actually uses.
 */

async function openRefereeDeck(page: Page) {
  await page.goto("/referee");
  // The deck seeds each Skins board's opening round on load.
  await page.waitForTimeout(4000);
}

test.describe("Skins knockout", () => {
  test("every board opens in the deck — no lane collision between 17 & Under and Open", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await login(page, CREDENTIALS.referee1);
    await openRefereeDeck(page);

    const cards = page.locator('[data-testid="skins-round-card"]');
    requireFixture((await cards.count()) > 0, "Skins qualifiers with a seeded opening round");

    // 17 & Under and Open of the same gender are the pair that used to
    // collide: they share a heat_group. Both must be present at once.
    await expect(cards.filter({ hasText: "17 & Under Men" }).first()).toBeVisible();
    await expect(cards.filter({ hasText: "Open Men" }).first()).toBeVisible();
    await expect(cards.filter({ hasText: "17 & Under Women" }).first()).toBeVisible();
    await expect(cards.filter({ hasText: "Open Women" }).first()).toBeVisible();

    await expect(page.getByText(/duplicate key value/i)).toHaveCount(0);
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });

  test("Skins is listed with the other races, not behind its own tab", async ({ page }) => {
    await login(page, CREDENTIALS.referee1);
    await openRefereeDeck(page);

    // The deck's own filter bar is still there, and Skins sits in the list
    // under it rather than in a separate view.
    await expect(page.getByText("Filter the deck")).toBeVisible();
    await expect(page.getByRole("button", { name: "Skins knockout" })).toHaveCount(0);
    await expect(page.getByText(/Knockout — placed, not timed/)).toBeVisible();
  });

  test("referee scores a round and an admin publishes it from the heat-card queue", async ({
    page,
  }) => {
    await login(page, CREDENTIALS.referee1);
    await openRefereeDeck(page);

    const card = page
      .locator('[data-testid="skins-round-card"]')
      .filter({ hasText: "Round of 6" })
      .filter({ hasNotText: "Published" })
      .first();
    requireFixture((await card.count()) > 0, "an unpublished Skins Round of 6");

    const laneRows = card.locator('[data-testid="skins-lane-row"]');
    const count = await laneRows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      await laneRows.nth(i).getByRole("button", { name: String(i + 1), exact: true }).click();
    }

    // The referee submits; only an admin can publish.
    await card.getByRole("button", { name: /Send .*round/ }).click();
    await expect(card.getByText("Awaiting admin")).toBeVisible({ timeout: 10_000 });
    await expect(card.getByRole("button", { name: /^Publish/ })).toHaveCount(0);

    // Clearing the session matters: signing in over a live one leaves the
    // form spinning on a disabled button and never navigates.
    await logout(page);
    await login(page, CREDENTIALS.admin);
    await page.goto("/admin");
    await page.getByRole("button", { name: /Referee Heat Cards/ }).click();
    await page.waitForTimeout(3000);

    // Earlier runs leave published rounds in the queue, and a published card
    // offers Reopen rather than Publish — so find one still awaiting review,
    // then re-locate it by TITLE. A locator carrying `hasNotText: Published`
    // stops matching the moment it is published, and would silently retarget
    // a different card.
    const awaiting = page
      .locator('[data-testid="review-heat-card"]')
      .filter({ hasText: "Round of 6" })
      .filter({ hasNotText: "Published" })
      .first();
    await expect(awaiting).toBeVisible({ timeout: 10_000 });
    const title = (await awaiting.locator("p.font-semibold").first().innerText()).trim();

    await awaiting.getByRole("button", { name: /Publish Heat Card/ }).click();
    await page.waitForTimeout(2500);

    const settled = page
      .locator('[data-testid="review-heat-card"]')
      .filter({ hasText: title })
      .first();
    // Published once, and says so instead of offering a second publish.
    await expect(settled.getByRole("button", { name: /Reopen to correct/ })).toBeVisible({
      timeout: 10_000,
    });
    await expect(settled.getByRole("button", { name: /Publish Heat Card/ })).toHaveCount(0);
  });

  test("advancing re-seeds the survivors into the centred lanes", async ({ page }) => {
    await login(page, CREDENTIALS.referee1);
    await openRefereeDeck(page);

    const advance = page.getByRole("button", { name: /Set up Round of 4/ }).first();
    requireFixture(
      (await advance.count()) > 0,
      "a fully scored Skins Round of 6 (run the scoring test first)",
    );
    await advance.click();
    await page.waitForTimeout(4000);

    const roundOfFour = page
      .locator('[data-testid="skins-round-card"]')
      .filter({ hasText: "Round of 4" })
      .first();
    await expect(roundOfFour).toBeVisible({ timeout: 10_000 });

    // Four survivors swim down the middle of the pool — never lanes 1 or 6.
    const lanes = await roundOfFour.locator('[data-testid="skins-lane-number"]').allInnerTexts();
    expect(lanes.length).toBeGreaterThan(0);
    expect(lanes).not.toContain("L1");
    expect(lanes).not.toContain("L6");
    if (lanes.length === 4) expect(lanes).toEqual(["L2", "L3", "L4", "L5"]);

    // And the round it came from is still there, intact — advancing used to
    // overwrite it, because every round shared one heat.
    await expect(
      page.locator('[data-testid="skins-round-card"]').filter({ hasText: "Round of 6" }).first(),
    ).toBeVisible();
  });
});
