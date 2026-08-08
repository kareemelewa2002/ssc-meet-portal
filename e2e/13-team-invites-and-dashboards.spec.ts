import { test, expect, type Page } from "@playwright/test";
import { CREDENTIALS, SEED_PASSWORD, login, requireFixture, tryLogin } from "./helpers";

/**
 * Covers everything added on top of the existing team/join-request domain:
 * captain-initiated invites (both the shareable link and the in-app
 * search-and-invite), the athlete/parent dashboard surfaces that read them,
 * and the athlete profile's new leaderboard-placement column.
 *
 * CREDENTIALS.unattached (athlete39) is the ONLY seeded athlete with
 * team_id = NULL, and 09-teams-and-captain.spec.ts's join-request tests
 * already depend on that staying true. There is no "leave team" action
 * anywhere in the app, so any test here that would ACCEPT an invite for
 * that account would permanently move it onto a roster and break every
 * other spec relying on it. Tests below that touch this fixture therefore
 * decline/revoke rather than accept — the invite-link auto-join path is
 * instead proven with a disposable, uniquely-emailed throwaway account.
 *
 * Anything that signs a SECOND account in does so in its own browser
 * context, never context.newPage(). Pages in one context share cookies, so
 * a second sign-in silently replaces the first page's session — the captain
 * would be signed out from under the assertions still to come.
 */

function uniqueEmail(prefix: string): string {
  // @gmail.com, matching 02-registration.spec.ts: local GoTrue is stricter
  // about the domains it will accept for a real signup than the admin API
  // seed-demo.sql uses for the @ssc-demo.test fixtures.
  return `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1000)}@gmail.com`;
}

/**
 * The two acknowledgement boxes, ticked the way 02-registration.spec.ts
 * established: force + an explicit toBeChecked(), because the signup form
 * re-renders as fields are filled and Playwright's stability heuristic can
 * time out on a checkbox it has already ticked.
 */
async function acceptTerms(page: Page) {
  const privacy = page.locator("#acceptPrivacy");
  const safety = page.locator("#acceptSafety");
  await privacy.check({ force: true });
  await safety.check({ force: true });
  await expect(privacy).toBeChecked();
  await expect(safety).toBeChecked();
}

/** Waits out the skeletons on /captain/invitations — every control below is
 * mounted only once fetchMyManagedTeam() resolves, so probing for one before
 * that resolves reads "absent" for a button that is merely late. */
async function openInvitationsPage(page: Page) {
  await page.goto("/captain/invitations", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Shareable link")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Pending invitations")).toBeVisible({ timeout: 20_000 });
}

test.describe("Captain: shareable invite link", () => {
  test("generating a link, then registering through it, auto-joins the team", async ({ page, browser }) => {
    test.slow();

    await login(page, CREDENTIALS.captainRiptide);
    await openInvitationsPage(page);

    // Exactly one of these exists once the card has loaded: "Create invite
    // link" when the team has none, "Regenerate" when a previous run left one
    // behind. Regenerating resets use_count to zero so this run's redemption
    // is unambiguous.
    const createBtn = page.getByRole("button", { name: /create invite link/i });
    if (await createBtn.count()) {
      await createBtn.click();
    } else {
      await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    }

    const code = page.locator("main code");
    await expect(code).toBeVisible({ timeout: 15_000 });
    const inviteUrl = (await code.textContent())?.trim();
    expect(inviteUrl).toMatch(/\/register\?invite=/);

    // A genuinely separate context: unauthenticated, no captain cookies.
    const guestContext = await browser.newContext();
    const registerPage = await guestContext.newPage();
    try {
      await registerPage.goto(inviteUrl!);
      await expect(registerPage.getByText(/You're signing up via an invite from/i)).toBeVisible({
        timeout: 15_000,
      });
      await expect(registerPage.getByText("Riptide Swim Club")).toBeVisible({ timeout: 15_000 });

      const email = uniqueEmail("e2e.invitee");
      await registerPage.locator("#fullName").fill("Invite Test Swimmer");
      await registerPage.locator("#email").fill(email);
      await registerPage.locator("#phone").fill("+201000000000");
      await registerPage.locator("#password").fill(SEED_PASSWORD);
      await registerPage.locator("#confirmPassword").fill(SEED_PASSWORD);
      await registerPage.locator("#dob").fill("2000-01-01"); // Open age, no parent gate
      await registerPage.getByRole("button", { name: "male", exact: true }).click();
      await acceptTerms(registerPage);
      await registerPage.getByRole("button", { name: "Create account" }).click();

      // GoTrue throttles signups two different ways and only one of them says
      // "rate limit" — see 02-registration.spec.ts. Exact text, not /account
      // created/i: the AppHeader title on this same screen is "Account
      // Created", and a case-insensitive match hits both, which is a
      // strict-mode violation rather than a pass.
      const rateLimited = registerPage.getByText(/rate limit|for security purposes/i);
      const success = registerPage.getByText("Account created!");
      await expect(rateLimited.or(success)).toBeVisible({ timeout: 30_000 });
      test.skip(
        await rateLimited.isVisible(),
        "Supabase auth email send rate limit hit — cannot exercise the signup path this run.",
      );
      await expect(success).toBeVisible();

      // The actual claim under test. Redemption happens server-side inside
      // public.handle_new_auth_user(), so "the form submitted" proves nothing
      // on its own — sign the new account in and confirm it landed on the
      // roster with no approval step.
      await login(registerPage, email);
      await registerPage.goto("/dashboard/team", { waitUntil: "domcontentloaded" });
      await expect(
        registerPage.locator('main [data-slot="card-title"]', { hasText: "Riptide Swim Club" }),
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      await guestContext.close();
    }
  });
});

test.describe("Captain: in-app invite + athlete-side response", () => {
  test("captain searches and invites an unattached athlete; it appears as Pending; athlete sees and declines it", async ({
    page,
    browser,
  }) => {
    test.slow();

    await login(page, CREDENTIALS.captainRiptide);
    await openInvitationsPage(page);

    // CREDENTIALS.unattached (athlete39) is seeded as "Selim Fahmy" — see
    // supabase/seed-demo.sql.
    const revokeSelim = page.getByRole("button", { name: "Revoke invitation to Selim Fahmy" });
    // An unclean previous run can leave the invite already sent. Cleared from
    // the Pending list, which renders straight from the server on load —
    // the search results below are behind a 350ms debounce plus a fetch, so
    // probing THEM for prior state reads empty every time regardless.
    if (await revokeSelim.count()) {
      await revokeSelim.click();
      await expect(revokeSelim).toHaveCount(0, { timeout: 15_000 });
    }

    const searchBox = page.getByLabel("Search unattached athletes");
    await searchBox.fill("Selim Fahmy");
    const inviteBtn = page.getByRole("button", { name: "Invite", exact: true });
    await expect(inviteBtn).toBeVisible({ timeout: 15_000 });
    await inviteBtn.click();

    // Asserted via the revoke control's aria-label rather than the bare name:
    // the name can legitimately appear twice (search result + pending row)
    // mid-transition, and getByText would fail strict mode on the overlap.
    await expect(revokeSelim).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Awaiting response")).toBeVisible();
    await expect(page.getByText(/Could not send that invite/i)).toHaveCount(0);

    // Athlete-side, in its own context so the captain above stays signed in.
    const athleteContext = await browser.newContext();
    const athletePage = await athleteContext.newPage();
    try {
      const signedIn = await tryLogin(athletePage, CREDENTIALS.unattached);
      requireFixture(signedIn, `the unattached athlete account ${CREDENTIALS.unattached}`);
      await athletePage.goto("/dashboard", { waitUntil: "domcontentloaded" });

      await expect(athletePage.getByText("Team invitation")).toBeVisible({ timeout: 15_000 });
      await expect(athletePage.getByText(/Riptide Swim Club invited you/i)).toBeVisible();
      // Decline, not accept — keeps athlete39 unattached for every other spec.
      await athletePage.getByRole("button", { name: "Decline", exact: true }).click();
      await expect(athletePage.getByText("Team invitation")).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await athleteContext.close();
    }

    // And the captain's pending list empties out once it's declined.
    await openInvitationsPage(page);
    await expect(revokeSelim).toHaveCount(0);
  });
});

test.describe("Athlete dashboard: current team", () => {
  test("an athlete already on a team sees a link to their roster & contacts page", async ({ page }) => {
    // approvedU17 is seeded on Riptide (see e2e/helpers.ts).
    await login(page, CREDENTIALS.approvedU17);
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

    // A Base UI Button rendered with render={<Link/>} exposes role="button",
    // not role="link" — same as the pre-existing "My Teams" button next to
    // it, confirmed by inspecting the actual accessibility tree rather than
    // assuming it from the markup.
    const teamLink = page.getByRole("button", { name: /my team — roster & contacts/i });
    await expect(teamLink).toBeVisible({ timeout: 15_000 });
    await teamLink.click();
    await expect(page).toHaveURL(/\/dashboard\/team/);

    // CardTitle renders a plain <div data-slot="card-title"> (see
    // components/ui/card.tsx) — it carries no heading role, so the team name
    // has to be matched on the slot rather than by getByRole("heading").
    await expect(
      page.locator('main [data-slot="card-title"]', { hasText: "Riptide Swim Club" }),
    ).toBeVisible({ timeout: 15_000 });
    // The page's whole point is contact info the athlete could not see before.
    await expect(page.getByText(/swimmers? on the roster/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('main a[href^="mailto:"]').first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Teams page: captain shown on the card", () => {
  test("every approved team card names its captain", async ({ page }) => {
    await login(page, CREDENTIALS.approvedU17);
    await page.goto("/teams", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/Captain:/).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Parent dashboard", () => {
  test("lists every linked child with a link to their results", async ({ page }) => {
    const signedIn = await tryLogin(page, CREDENTIALS.parent1);
    requireFixture(signedIn, `the parent account ${CREDENTIALS.parent1}`);
    await page.goto("/parent", { waitUntil: "domcontentloaded" });

    // Scoped to main: AppHeader renders the page title in its own <h1>, so an
    // unscoped heading query matches twice and fails strict mode.
    await expect(
      page.locator("main").getByRole("heading", { name: "Parent Dashboard" }),
    ).toBeVisible({ timeout: 15_000 });
    const resultsLinks = page.getByRole("link", { name: /Results, PBs & leaderboard placements/i });
    // parent1 has 4 linked children per e2e/helpers.ts.
    await expect(resultsLinks).toHaveCount(4, { timeout: 15_000 });
  });
});

test.describe("Athlete profile: leaderboard placement column", () => {
  test("the career ledger shows both Heat place and Leaderboard place", async ({ page }) => {
    await login(page, CREDENTIALS.approvedU17);
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /my results/i }).click();
    await expect(page).toHaveURL(/\/athletes\//);

    const ledger = page.getByTestId("career-ledger");
    await expect(ledger).toBeVisible({ timeout: 15_000 });
    await expect(ledger.getByRole("columnheader", { name: "Heat" })).toBeVisible();
    await expect(ledger.getByRole("columnheader", { name: "Leaderboard" })).toBeVisible();
  });
});
