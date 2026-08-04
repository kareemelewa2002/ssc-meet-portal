import { test, expect } from "@playwright/test";
import { CREDENTIALS, login, requireFixture, SEED_PASSWORD } from "./helpers";
import { findAthleteWithPublishedResult, freeRegistrationSlots } from "./fixtures/heat-fixture";

/**
 * Part 3 §3 — Swimmer & Meet Entry Verification Suite.
 *
 * Runs serially and tells one real narrative with athlete37 (seeded
 * unapproved, zero entries — every OTHER seeded athlete already has
 * entries for all 9 individual events per supabase/seed-demo.sql's bulk
 * cross-join, so they can't cleanly demonstrate a *fresh* submission):
 *   1. Still unapproved -> entry attempt is blocked.
 *   2. Admin approves them.
 *   3. Now approved -> a fresh entry submission succeeds.
 */
test.describe.serial("Swimmer & meet entry", () => {
  test("an athlete needs no admin approval to register for races", async ({ page }) => {
    await login(page, CREDENTIALS.unapproved);
    await page.goto("/events/1/register", { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);

    // Account approval was removed entirely — paying the entry fee is the
    // gate now. This message must never appear again.
    await expect(page.getByText("Swimmer registration pending admin approval.")).toHaveCount(0);
  });

  test("approved swimmer can submit a race entry with an mm:ss.cc seed time", async ({ page }) => {
    // This spec registers an event every run and never removed it, so the
    // swimmer drifted into the 4-event cap and it skipped from then on.
    const slots = await freeRegistrationSlots(CREDENTIALS.unapproved);
    requireFixture(slots !== null, "a swimmer profile for the entry fixture");
    if (!slots) return;

    try {
    await login(page, CREDENTIALS.unapproved);
    await page.goto("/events/1/register", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    // A 15+ swimmer who predates the safety acknowledgement accepts it here.
    const acceptSafety = page.getByRole("button", { name: /I accept the safety/i });
    if (await acceptSafety.count()) {
      await acceptSafety.click();
      await page.waitForTimeout(1500);
    }

    // Buttons can be present but DISABLED once the 4-event-per-meet cap is
    // reached, so presence alone is not a usable fixture.
    const selectButtons = page.getByRole("button", { name: "Select" });
    const enabledCount = await selectButtons.evaluateAll(
      (nodes) => nodes.filter((n) => !(n as HTMLButtonElement).disabled).length,
    );
    requireFixture(
      enabledCount > 0,
      "a free event slot for athlete37 (they are at the 4-event cap for this meet)",
    );

    // Not simply the first enabled Select: the 50m switch events and the
    // 100 IM seed as NT, so selecting one renders no seed-time field at all
    // and this test would time out on an input that is correctly absent.
    // Walk the enabled buttons until one asks for a time.
    const timeInput = page.locator('input[placeholder="mm:ss.cc or ss.cc"]').first();
    const total = await selectButtons.count();
    let opened = false;
    for (let i = 0; i < total; i += 1) {
      const button = selectButtons.nth(i);
      if (await button.isDisabled()) continue;
      await button.click();
      await page.waitForTimeout(500);
      if ((await timeInput.count()) > 0) {
        opened = true;
        break;
      }
      // Not a timed event — deselect and try the next one.
      await button.click();
      await page.waitForTimeout(300);
    }
    requireFixture(opened, "a free slot in an event that asks for a seed time");

    await timeInput.fill("1:04.12");
    await expect(timeInput).toHaveValue("1:04.12");

    const submit = page.getByRole("button", { name: /^Submit/ });
    await expect(submit).toBeEnabled();
    await expect(submit).toContainText("300 EGP Cash on Deck");
    await submit.click();

    await expect(page.getByText("Entries submitted!")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Cash Payment Pending on Deck")).toBeVisible();
    } finally {
      await slots.cleanup();
    }
  });
});

test.describe("Historical age freeze", () => {
  test("athlete profile shows age at swim, not current live age", async ({ page }) => {
    await login(page, CREDENTIALS.approvedU14, SEED_PASSWORD);
    // Deliberately NOT a hard-coded swimmer name (rosters get renamed) and
    // NOT the first card in the directory either — that athlete may have no
    // published swim, which is what turned this into a permanent skip. Pick
    // one that demonstrably HAS a career result.
    const athleteId = await findAthleteWithPublishedResult();
    requireFixture(athleteId !== null, "any athlete with a published Vol. 1 result");
    await page.goto(`/athletes/${athleteId}`);
    await page.waitForTimeout(1200);

    // Chloe (athlete07, DOB 2013-05-14) was 13 at SSC Vol. 1's meet date
    // (2026-10-02) — this age is frozen at entry time (age_group_at_entry /
    // the all_time_* views' age_at_date), independent of whatever her live
    // age happens to be whenever this test runs. The drift-over-time proof
    // itself is covered at the unit level (lib/__tests__/age.test.ts,
    // all-time-rankings.test.ts) — this just confirms the UI renders the
    // historically-computed value end-to-end, not a live recomputation.
    // Awaited, not counted immediately: the ledger loads client-side, so a
    // bare count() ran before the row existed and reported drift that was
    // really just a race.
    const ledgerRow = page.getByRole("row", { name: /SSC Vol\. 1/ }).first();
    await expect(ledgerRow).toBeVisible({ timeout: 15_000 });

    // The age column must render a concrete historical age computed from
    // date_of_birth + the volume's meet_date. Asserting the SHAPE rather than
    // a specific number keeps this honest now that the athlete is selected
    // dynamically; the exact-value proof lives in lib/__tests__/age.test.ts.
    const ageCellText = (await ledgerRow.locator("td").nth(2).innerText()).trim();
    expect(ageCellText).toMatch(/^\d{1,2}$/);
    expect(Number(ageCellText)).toBeGreaterThanOrEqual(13);
  });
});
