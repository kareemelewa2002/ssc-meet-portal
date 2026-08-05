import { test, expect } from "@playwright/test";
import { CREDENTIALS, login, requireFixture, tryLogin } from "./helpers";

test.describe("/captain route", () => {
  test("a team captain reaches the Captain Dashboard, not a 404", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await login(page, CREDENTIALS.captainRiptide);
    await page.goto("/captain");
    await page.waitForTimeout(1500);

    await expect(page.locator("main").getByRole("heading", { name: "Captain Dashboard" })).toBeVisible();
    await expect(page.getByText(/No team currently lists you as its captain/i)).toHaveCount(0);
    await expect(page.getByText("404")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a swimmer who captains nothing sees the gate, never someone else's roster", async ({ page }) => {
    await login(page, CREDENTIALS.approvedOpen);
    await page.goto("/captain");
    await page.waitForTimeout(1500);

    await expect(page.locator("main").getByRole("heading", { name: "Captain Dashboard" })).toBeVisible();
    // Captaincy is teams.captain_id, so the gate is "does a team point at me",
    // not "do you hold a role".
    await expect(page.getByText(/No team currently lists you as its captain/i)).toBeVisible();
    await expect(page.getByText("Riptide Swim Club")).toHaveCount(0);
  });

  test("only the captain can build a relay squad", async ({ page }) => {
    await login(page, CREDENTIALS.captainRiptide);
    await page.goto("/captain", { waitUntil: "networkidle" });

    // Scoped by data-slot, not by role: CardTitle renders a <div>, so
    // getByRole("heading") never matches it — and a bare getByText matches
    // both the title and its wrapper, which is a strict-mode violation.
    // Await hydration of fetchCaptainedTeams() rather than a fixed sleep —
    // local stacks routinely exceed 1.5s before RelayBuilder mounts.
    const title = page.locator('[data-slot="card-title"]', { hasText: "Relay squads" });
    await expect(title).toBeVisible({ timeout: 20_000 });
    // The composition rule is stated up front rather than only on submit.
    await expect(page.getByLabel("Relay")).toBeVisible();
    await expect(page.getByLabel("Age group")).toBeVisible();
  });
});

test.describe("Team creation restriction (Open 18+ / Admin only)", () => {
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

  test("an account with no swimmer profile never sees the Create Team button", async ({ page }) => {
    // Founding a team requires being an Open (18+) swimmer or an admin, so an
    // account with no athletes row at all fails can_captain_team() and the
    // button is correctly absent. A parent is the fixture for that now: this
    // test used to point at the Riptide captain, back when that account was an
    // ex-'coach' with no swimmer profile — which was also the bug that left
    // the seeded captains unable to found the teams they captain.
    await login(page, CREDENTIALS.parent1);
    await page.goto("/teams");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("button", { name: "Create Team", exact: true })).toHaveCount(0);
  });

  test("a team captain, being an Open (18+) athlete, sees the Create Team button", async ({
    page,
  }) => {
    // The definition the platform enforces: a captain is an athlete who
    // created the team and is 18 or over. Anyone who can captain a team must
    // therefore satisfy can_captain_team() — if this fails, the seed is
    // shipping a captain who could never have created their own team.
    await login(page, CREDENTIALS.captainRiptide);
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

    // The UI now explains the lock up-front rather than offering a button
    // whose only outcome is a server-side rejection, so the assertion is
    // that the locked state is VISIBLE and no request affordance exists.
    await expect(page.getByText(/Transfers Locked Until Meet Ends/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Request to Join Team" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Cancel Request \(Pending\)/ })).toHaveCount(0);
  });

  test("an unattached athlete can request to join a team, then cancel it", async ({ page }) => {
    const signedIn = await tryLogin(page, CREDENTIALS.unattached);
    requireFixture(signedIn, `the unattached athlete account ${CREDENTIALS.unattached}`);
    await page.goto("/teams", { waitUntil: "domcontentloaded" });

    // A leftover pending request (previous run, or a cancelled cleanup that
    // never finished) disables every other Request button — clear it first.
    const leftover = page.getByRole("button", { name: /Cancel Request \(Pending\)/ });
    if (await leftover.count()) {
      await leftover.first().click();
      await expect(leftover).toHaveCount(0, { timeout: 15_000 });
    }

    const requestButtons = page.getByRole("button", { name: "Request to Join Team" });
    await expect(requestButtons.first()).toBeEnabled({ timeout: 20_000 });

    await requestButtons.first().click();

    const cancelButton = page.getByRole("button", { name: /Cancel Request \(Pending\)/ });
    await expect(cancelButton).toBeVisible({ timeout: 15_000 });

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
    // The longest flow in the suite: two browser contexts, two full sign-ins,
    // and a chain of 15-20s waits on realtime-backed lists. It was overrunning
    // the 90s default at the very LAST step — the reject had already gone
    // through — so this is a budget problem, not a broken flow. Tripled rather
    // than trimming the waits, which are what make the test reliable.
    test.slow();

    // Requester (athlete13) files a request to Blue Marlins.
    const requesterPage = await context.newPage();
    // Must be the unattached athlete — anyone already on a team is blocked by
    // the transfer lock while the volume is 'scheduled'.
    const signedIn = await tryLogin(requesterPage, CREDENTIALS.unattached);
    requireFixture(signedIn, `the unattached athlete account ${CREDENTIALS.unattached}`);
    await requesterPage.goto("/teams", { waitUntil: "domcontentloaded" });

    const blueMarlinsCard = requesterPage.locator('[data-slot="card"]', { hasText: "Blue Marlins" });
    // Clear any pending request left on another team so Blue Marlins is requestable.
    const leftover = requesterPage.getByRole("button", { name: /Cancel Request \(Pending\)/ });
    if (await leftover.count()) {
      await leftover.first().click();
      await expect(leftover).toHaveCount(0, { timeout: 15_000 });
    }
    const requestBtn = blueMarlinsCard.getByRole("button", { name: "Request to Join Team" });
    await expect(requestBtn).toBeEnabled({ timeout: 20_000 });
    await requestBtn.click();
    await expect(
      blueMarlinsCard.getByRole("button", { name: /Cancel Request \(Pending\)/ }),
    ).toBeVisible({ timeout: 15_000 });

    // Captain (captain.riptide manages Riptide, not Blue Marlins — use the
    // Blue Marlins captain instead: captain.marlins, per SEED_CREDENTIALS.md).
    await login(page, CREDENTIALS.captainMarlins);
    await page.goto("/teams", { waitUntil: "domcontentloaded" });
    const marlinsCard = page.locator('[data-slot="card"]', { hasText: "Blue Marlins" });
    const rosterBtn = marlinsCard.getByRole("button", { name: "View Roster & Captain Contact" });
    await expect(rosterBtn).toBeVisible({ timeout: 20_000 });
    await rosterBtn.scrollIntoViewIfNeeded();
    await rosterBtn.click();

    const joinRequestsHeading = page.getByText(/Join Requests/);
    await expect(joinRequestsHeading).toBeVisible({ timeout: 20_000 });
    const rejectBtn = page.getByRole("button", { name: "Reject" }).first();
    await expect(rejectBtn).toBeVisible({ timeout: 15_000 });
    // Reject rather than accept, so this test doesn't permanently move the
    // unattached fixture onto Blue Marlins' roster on every run.
    await rejectBtn.click();
    await page.waitForTimeout(1000);

    await requesterPage.close();
  });
});
