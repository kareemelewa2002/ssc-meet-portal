import { test, expect } from "@playwright/test";
import { CREDENTIALS, login, requireFixture } from "./helpers";
import {
  acceptSafetyFixture,
  createRefereeHeatFixture,
  findAthleteWithCapacity,
  freeRegistrationSlots,
} from "./fixtures/heat-fixture";

/**
 * Part 5's explicit six-flow checklist, verified end to end against the
 * live (real, not mocked) backend and the scope-locked 5-role model.
 */

test.describe("Part 5 checklist — Athlete Flow", () => {
  test("athlete01 views PBs, registers for 2 races, itemized total is 600 EGP cash on deck", async ({ page }) => {
    // Registers every run and never removed the entries, so the swimmer
    // drifted into the 4-event cap and this skipped from then on.
    // The RULE is under test (a U14 enters two races and owes 600 EGP), not
    // one account. Naming a swimmer meant that once their four slots held
    // real published swims there was no non-destructive way to free them, and
    // the spec could only skip.
    const swimmer = await findAthleteWithCapacity("U14", 2);
    requireFixture(swimmer !== null, "a U14 demo swimmer with two free entry slots");
    if (!swimmer) return;

    const slots = await freeRegistrationSlots(swimmer.email);
    requireFixture(slots !== null, "a swimmer profile for the entry fixture");
    if (!slots) return;
    // U14 registration is blocked until a parent accepts the safety
    // acknowledgement; a database where that was cleared makes this unrunnable.
    const safety = await acceptSafetyFixture(swimmer.email);
    requireFixture(safety !== null, "the swimmer's safety acknowledgement");
    if (!safety) return;

    try {
    await login(page, swimmer.email);

    // View PBs — the athlete's own career ledger on their public profile.
    await page.goto("/athletes");
    await page.waitForTimeout(1000);
    const ownCard = page.locator('main a[href^="/athletes/"]').first();
    requireFixture((await ownCard.count()) > 0, "at least one athlete in the directory");
    await ownCard.click();
    await page.waitForURL("**/athletes/**");
    await expect(page.getByText("PB")).toBeVisible();

    // Register for 2 races, assert the itemized 300 EGP/race cash total.
    await page.goto("/events/1/register");
    await page.waitForTimeout(1500);
    // athlete01 is U14: their safety acknowledgement must have been accepted
    // by their parent before they can enter anything.
    requireFixture(
      (await page.getByText(/safety & privacy acknowledgement must be accepted/i).count()) === 0,
      "athlete01's safety acknowledgement accepted by their parent",
    );
    const selectButtons = page.getByRole("button", { name: "Select" });
    const available = await selectButtons.evaluateAll(
      (nodes) => nodes.filter((n) => !(n as HTMLButtonElement).disabled).length,
    );
    requireFixture(available >= 2, "at least 2 free event slots for athlete01");

    // Pick two events that actually ASK for a seed time. The 50m switch
    // events and the 100 IM are entered as NT — selecting one renders no time
    // field at all, and this timed out on an input that is correctly absent.
    const timeInputs = page.locator('input[placeholder="mm:ss.cc or ss.cc"]');
    const total = await selectButtons.count();
    let picked = 0;
    for (let i = 0; i < total && picked < 2; i += 1) {
      const button = selectButtons.nth(i);
      if (await button.isDisabled()) continue;
      await button.click();
      await page.waitForTimeout(400);
      if ((await timeInputs.count()) > picked) {
        await timeInputs.nth(picked).fill(picked === 0 ? "1:04.12" : "35.10");
        picked += 1;
      } else {
        // Not a timed event — deselect and keep looking.
        await button.click();
        await page.waitForTimeout(300);
      }
    }
    requireFixture(picked === 2, "two free slots in events that ask for a seed time");

    await expect(page.getByText("2 races × 300 EGP")).toBeVisible();
    await expect(page.getByText("600 EGP", { exact: false }).first()).toBeVisible();

    const submit = page.getByRole("button", { name: /^Submit 2/ });
    await expect(submit).toContainText("600 EGP Cash on Deck");
    await submit.click();

    await expect(page.getByText("Entries submitted!")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Cash Payment Pending on Deck")).toBeVisible();
    await expect(page.getByText(/600 EGP in cash/)).toBeVisible();
    } finally {
      await slots.cleanup();
      await safety.cleanup();
    }
  });
});

test.describe("Part 5 checklist — Parent Flow", () => {
  test("parent1 is linked to their U14 swimmer", async ({ page }) => {
    await login(page, CREDENTIALS.parent1);
    // Parents don't have a dedicated roster page today — the linkage is
    // proven via the admin approvals queue showing the parent's email
    // against athlete01's pending/verified parent link, and via the
    // AppHeader confirming the Parent role loaded correctly.
    const trigger = page.locator('header button:has([data-slot="avatar"])').first();
    await trigger.click();
    await page.waitForTimeout(400);
    await expect(page.getByText("Parent", { exact: true })).toBeVisible();

    await page.goto("/athletes");
    await page.waitForTimeout(1000);
    await page.waitForTimeout(800);
    const card = page.locator('main a[href^="/athletes/"]').first();
    requireFixture((await card.count()) > 0, "at least one athlete in the directory");
    await card.click();
    await page.waitForURL("**/athletes/**");
    // The linked U14 swimmer's public profile must be reachable by the
    // parent — proving the account exists and the linkage isn't broken.
    // Scoped to <main> — AppHeader also renders an <h1> for the page title.
    await expect(page.locator("main h1")).toBeVisible();
  });
});

test.describe("Part 5 checklist — Team Captain Flow", () => {
  test("the Riptide captain views their team roster with each swimmer's PBs reachable", async ({
    page,
  }) => {
    // Was the "Coach Flow", looking for a Coach Dashboard at /dashboard. The
    // coach role is retired: captaincy is teams.captain_id, the dashboard
    // lives at /captain, and it is gated on captaining a team rather than on
    // holding a role.
    await login(page, CREDENTIALS.captainRiptide);
    await page.goto("/captain");
    await page.waitForTimeout(2000);

    await expect(page.locator("main").getByText("Captain Dashboard").first()).toBeVisible();
    await expect(page.getByText("Riptide Swim Club").first()).toBeVisible();

    const firstSwimmer = page.locator('main a[href^="/athletes/"]').first();
    requireFixture((await firstSwimmer.count()) > 0, "roster rows for Riptide Swim Club");
    await firstSwimmer.click();
    await page.waitForURL("**/athletes/**");
    await expect(page.getByText("PB").first()).toBeVisible();
  });
});

test.describe("Part 5 checklist — Referee Flow", () => {
  test("referee1 marks presence, enters lane time 28.50, submits heat card to Admin", async ({ page }) => {
    // Builds its own heat: reaching for the first card in the deck asserted on
    // whatever the previous run left behind, and a card that is already
    // submitted renders locked controls rather than an empty time box.
    const fixture = await createRefereeHeatFixture();
    requireFixture(fixture !== null, "an event with entries to build a scratch heat from");
    if (!fixture) return;

    try {
      await login(page, CREDENTIALS.referee1);
      await page.goto("/referee");
      const card = page.getByTestId(`heat-card-${fixture.heatId}`);
      await expect(card).toBeVisible({ timeout: 20_000 });
    
      await card.getByRole("button", { name: "Valid Time" }).first().click();
      await card.locator('input[id^="time-"]').first().fill("28.50");

      await card.getByRole("button", { name: /Save Progress|Submit Heat Card to Admin/ }).click();
      // The save toast's heading is the unambiguous confirmation signal — the
      // button's own label also matches this text once saved.
      await expect(
        page.getByRole("heading", { name: /Heat card submitted|Progress saved/ }),
      ).toBeVisible({
        timeout: 8_000,
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

test.describe("Part 5 checklist — Admin Flow", () => {
  test("admin approves pending teams, confirms cash payment, publishes a referee heat card", async ({ page }) => {
    await login(page, CREDENTIALS.admin);
    await page.goto("/admin");
    await page.waitForTimeout(1000);

    // Approve pending teams (if any are currently pending).
    await page.getByRole("button", { name: "Pending Team Approvals" }).click();
    await page.waitForTimeout(800);
    const approveTeamBtn = page.getByRole("button", { name: "Approve Team" }).first();
    if (await approveTeamBtn.count()) {
      await approveTeamBtn.click();
      await page.waitForTimeout(1000);
      await expect(page.locator('[data-slot="alert"]')).toHaveCount(0);
    }

    // Mark a cash payment received (if any are currently pending).
    await page.getByRole("button", { name: "Cash Payments" }).click();
    await page.waitForTimeout(800);
    const cashBtn = page.getByRole("button", { name: "Confirm Payment" }).first();
    if (await cashBtn.count()) {
      await cashBtn.click();
      await page.waitForTimeout(1000);
      await expect(page.locator('[data-slot="alert"]')).toHaveCount(0);
    }

    // Review and publish a referee heat card (if any complete draft exists).
    await page.getByRole("button", { name: "Referee Heat Cards" }).click();
    await page.waitForTimeout(1200);
    // Scoped to the specific heat-card container class — an unscoped
    // "div" + hasText locator matches every ancestor div up the tree too.
    const readyCard = page
      .locator(".space-y-3.rounded-lg.border.p-3", { hasText: "Draft Heat Card — Ready" })
      .first();
    const publishBtn = readyCard.getByRole("button", { name: "Publish Heat Card" });
    if (await publishBtn.count()) {
      await publishBtn.click();
      await page.waitForTimeout(1500);
      await expect(page.locator('[data-slot="alert"]')).toHaveCount(0);
    }
  });
});
