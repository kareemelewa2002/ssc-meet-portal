import { test, expect } from "@playwright/test";
import { CREDENTIALS, login } from "./helpers";

test.describe("/coach route", () => {
  test("coach.riptide reaches the Coach Dashboard, not a 404", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await login(page, CREDENTIALS.coachRiptide);
    await page.goto("/coach");
    await page.waitForTimeout(1200);

    await expect(page.locator("main").getByRole("heading", { name: "Coach Dashboard" })).toBeVisible();
    await expect(page.getByText(/only available to Coach accounts/i)).toHaveCount(0);
    await expect(page.getByText("404")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a non-coach (athlete) sees the role-gated message, never someone else's roster", async ({ page }) => {
    await login(page, CREDENTIALS.approvedOpen);
    await page.goto("/coach");
    await page.waitForTimeout(1200);

    await expect(page.locator("main").getByRole("heading", { name: "Coach Dashboard" })).toBeVisible();
    await expect(page.getByText(/only available to Coach accounts/i)).toBeVisible();
    // Must not leak a real team roster to a non-coach.
    await expect(page.getByText("Riptide Swim Club")).toHaveCount(0);
  });
});

test.describe("Team creation restriction (Open 18+ / Coach / Admin only)", () => {
  test("a U14 athlete never sees the Create Team button", async ({ page }) => {
    await login(page, CREDENTIALS.approvedU14);
    await page.goto("/teams");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("button", { name: "Create Team", exact: true })).toHaveCount(0);
    await expect(page.getByText(/Only Open age-group \(18\+\) athletes, coaches, or admins/i)).toBeVisible();
  });

  test("a U17 athlete never sees the Create Team button", async ({ page }) => {
    await login(page, CREDENTIALS.approvedU17);
    await page.goto("/teams");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("button", { name: "Create Team", exact: true })).toHaveCount(0);
  });

  test("an Open (18+) athlete sees the Create Team button", async ({ page }) => {
    await login(page, CREDENTIALS.approvedOpen);
    await page.goto("/teams");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("button", { name: "Create Team", exact: true })).toBeVisible();
  });

  test("a coach sees the Create Team button", async ({ page }) => {
    await login(page, CREDENTIALS.coachRiptide);
    await page.goto("/teams");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("button", { name: "Create Team", exact: true })).toBeVisible();
  });
});

test.describe("Team join-request workflow", () => {
  test("an athlete can request to join a team they're not on, then cancel it", async ({ page }) => {
    await login(page, CREDENTIALS.approvedU17); // athlete13, Riptide Swim Club
    await page.goto("/teams");
    await page.waitForTimeout(1500);

    // Find a team card that is NOT "Your Team" and has an active "Request
    // to Join Team" button (not already pending elsewhere from a prior run).
    const requestButtons = page.getByRole("button", { name: "Request to Join Team" });
    test.skip(!(await requestButtons.count()), "No other-team join button available (already pending or every team is this athlete's own).");

    await requestButtons.first().click();
    await page.waitForTimeout(1200);

    const cancelButton = page.getByRole("button", { name: /Cancel Request \(Pending\)/ });
    await expect(cancelButton).toBeVisible();

    // Single-pending-request rule: every OTHER "Request to Join Team"
    // button must now be disabled while this one is pending.
    const otherRequestButtons = page.getByRole("button", { name: "Request to Join Team" });
    const otherCount = await otherRequestButtons.count();
    for (let i = 0; i < otherCount; i++) {
      await expect(otherRequestButtons.nth(i)).toBeDisabled();
    }

    // Clean up — cancel so this test is safely repeatable.
    await cancelButton.click();
    await page.waitForTimeout(1000);
    await expect(page.getByRole("button", { name: "Request to Join Team" }).first()).toBeEnabled();
  });

  test("a team's captain sees a pending join request and can accept or reject it in the roster modal", async ({ page, context }) => {
    // Requester (athlete13) files a request to Blue Marlins.
    const requesterPage = await context.newPage();
    await login(requesterPage, CREDENTIALS.approvedU17);
    await requesterPage.goto("/teams");
    await requesterPage.waitForTimeout(1500);

    const blueMarlinsCard = requesterPage.locator('[data-slot="card"]', { hasText: "Blue Marlins" });
    const requestBtn = blueMarlinsCard.getByRole("button", { name: "Request to Join Team" });
    test.skip(!(await requestBtn.count()), "athlete13 already has a pending/accepted relationship with Blue Marlins.");
    await requestBtn.click();
    await requesterPage.waitForTimeout(1200);

    // Captain (coach.riptide manages Riptide, not Blue Marlins — use the
    // Blue Marlins captain instead: coach.marlins, per SEED_CREDENTIALS.md).
    await login(page, CREDENTIALS.coachMarlins);
    await page.goto("/teams");
    await page.waitForTimeout(1500);
    const marlinsCard = page.locator('[data-slot="card"]', { hasText: "Blue Marlins" });
    await marlinsCard.getByRole("button", { name: "View Roster & Captain Contact" }).click();
    await page.waitForTimeout(800);

    const joinRequestsHeading = page.getByText(/Join Requests/);
    await expect(joinRequestsHeading).toBeVisible();
    const rejectBtn = page.getByRole("button", { name: "Reject" }).first();
    await expect(rejectBtn).toBeVisible();
    // Reject rather than accept, so this test doesn't permanently move
    // athlete13 onto Blue Marlins' roster on every run.
    await rejectBtn.click();
    await page.waitForTimeout(1000);

    await requesterPage.close();
  });
});
