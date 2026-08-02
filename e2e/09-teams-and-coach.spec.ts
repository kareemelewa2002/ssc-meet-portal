import { test, expect } from "@playwright/test";
import { CREDENTIALS, login, requireFixture, tryLogin } from "./helpers";

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
  test("transfer lock: an athlete already on a team cannot request a move mid-meet", async ({ page }) => {
    // athlete13 is on Riptide, and SSC Vol. 1 is 'scheduled', so
    // enforce_team_membership_request_rules() must refuse the request. This
    // used to be written as a happy-path join test, which only passed while
    // the trigger was missing from the live database — the app was right and
    // the test was wrong. The DB-level proof lives in DB-04/DB-05.
    await login(page, CREDENTIALS.approvedU17);
    await page.goto("/teams", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    const requestButtons = page.getByRole("button", { name: "Request to Join Team" });
    requireFixture((await requestButtons.count()) > 0, "another team for athlete13 to attempt joining");

    await requestButtons.first().click();
    await page.waitForTimeout(1500);

    // The failure must be surfaced, not swallowed.
    await expect(page.getByText(/Couldn.t send join request/i)).toBeVisible();
    await expect(page.getByText(/transfers are locked/i)).toBeVisible();
    // ...and no pending state may be created.
    await expect(page.getByRole("button", { name: /Cancel Request \(Pending\)/ })).toHaveCount(0);
  });

  test("an unattached athlete can request to join a team, then cancel it", async ({ page }) => {
    const signedIn = await tryLogin(page, CREDENTIALS.unattached);
    requireFixture(signedIn, `the unattached athlete account ${CREDENTIALS.unattached}`);
    await page.goto("/teams", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    const requestButtons = page.getByRole("button", { name: "Request to Join Team" });
    requireFixture(
      (await requestButtons.count()) > 0,
      "the unattached athlete fixture (athlete39, team_id NULL) with no pending request",
    );

    await requestButtons.first().click();
    await page.waitForTimeout(1500);

    const cancelButton = page.getByRole("button", { name: /Cancel Request \(Pending\)/ });
    await expect(cancelButton).toBeVisible();

    // Single-pending-request rule: every OTHER request button is now disabled.
    const others = page.getByRole("button", { name: "Request to Join Team" });
    for (let i = 0; i < (await others.count()); i++) {
      await expect(others.nth(i)).toBeDisabled();
    }

    // Cancel so the test is repeatable.
    await cancelButton.click();
    await page.waitForTimeout(1200);
    await expect(page.getByRole("button", { name: "Request to Join Team" }).first()).toBeEnabled();
  });

  test("a team's captain sees a pending join request and can accept or reject it in the roster modal", async ({ page, context }) => {
    // Requester (athlete13) files a request to Blue Marlins.
    const requesterPage = await context.newPage();
    // Must be the unattached athlete — anyone already on a team is blocked by
    // the transfer lock while the volume is 'scheduled'.
    const signedIn = await tryLogin(requesterPage, CREDENTIALS.unattached);
    requireFixture(signedIn, `the unattached athlete account ${CREDENTIALS.unattached}`);
    await requesterPage.goto("/teams", { waitUntil: "networkidle" });
    await requesterPage.waitForTimeout(2000);

    const blueMarlinsCard = requesterPage.locator('[data-slot="card"]', { hasText: "Blue Marlins" });
    const requestBtn = blueMarlinsCard.getByRole("button", { name: "Request to Join Team" });
    requireFixture(
      (await requestBtn.count()) > 0,
      "the unattached athlete fixture (athlete39) able to request Blue Marlins",
    );
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
    // Reject rather than accept, so this test doesn't permanently move the
    // unattached fixture onto Blue Marlins' roster on every run.
    await rejectBtn.click();
    await page.waitForTimeout(1000);

    await requesterPage.close();
  });
});
