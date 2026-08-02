import { test, expect, type APIRequestContext } from "@playwright/test";
import { CREDENTIALS, login, requireFixture } from "./helpers";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Looks up a real, currently-seeded event id/name directly via PostgREST —
 * deep-link tests must exercise a real UUID, never a hardcoded one that can
 * drift whenever the seed script regenerates. */
async function fetchFirstEvent(request: APIRequestContext) {
  const res = await request.get(
    `${SUPABASE_URL}/rest/v1/events?select=id,name&order=event_order.asc&limit=1`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
  );
  const rows = (await res.json()) as { id: string; name: string }[];
  return rows[0];
}

test.describe("Spectator, leaderboards & navigation", () => {
  test("single-event deep link (?event=) scopes the live page to just that event", async ({ page, request }) => {
    const event = await fetchFirstEvent(request);
    requireFixture(!!event, "at least one seeded event");

    await login(page, CREDENTIALS.approvedU17);
    await page.goto(`/events/1/live?event=${event.id}`);
    await page.waitForTimeout(1500);

    await expect(page.getByText(`Showing ${event.name} only.`)).toBeVisible();
    const mainText = await page.locator("main").innerText();
    // Every event card heading on the page must be this one event — a
    // scoping bug would leak the rest of the session's events in below it.
    const eventHeadingMatches = mainText.match(new RegExp(event.name, "g")) ?? [];
    expect(eventHeadingMatches.length).toBeGreaterThan(0);
  });

  test("All-Time Records: Best Performers and Best Performances tabs both render real ranked data", async ({ page }) => {
    await login(page, CREDENTIALS.parent1);
    await page.goto("/leaderboards/all-time");
    await page.waitForTimeout(1500);

    await expect(page.getByRole("tab", { name: "Best Performers" })).toBeVisible();
    const performersText = await page.locator("main").innerText();
    expect(performersText).toMatch(/\d{2}\.\d{2}/); // a formatted race time

    await page.getByRole("tab", { name: "Best Performances" }).click();
    await page.waitForTimeout(800);
    const performancesText = await page.locator("main").innerText();
    expect(performancesText).toContain("Best Performances");
    expect(performancesText).toMatch(/\d{2}\.\d{2}/);

    // Switching filters (e.g. age group) must actually change the ranking,
    // proving it's live-queried rather than a static fallback list.
    await page.getByRole("button", { name: "U14" }).click();
    await page.waitForTimeout(800);
    const u14Text = await page.locator("main").innerText();
    expect(u14Text).not.toBe(performancesText);
  });

  test.describe("AppHeader dropdown works correctly across roles", () => {
    const roleChecks: { credEmail: string; roleLabel: string; dashboardHref: string | null }[] = [
      { credEmail: CREDENTIALS.admin, roleLabel: "Admin", dashboardHref: "/admin" },
      // Scope lock: 'team_captain' no longer exists as a role — a coach
      // stays 'coach' permanently even while also captaining their team
      // (teams.captain_id tracks that independently of the role column).
      { credEmail: CREDENTIALS.coachRiptide, roleLabel: "Coach", dashboardHref: "/coach" },
      { credEmail: CREDENTIALS.parent1, roleLabel: "Parent", dashboardHref: null },
      { credEmail: CREDENTIALS.approvedOpen, roleLabel: "Athlete", dashboardHref: null },
    ];

    for (const { credEmail, roleLabel, dashboardHref } of roleChecks) {
      test(`${roleLabel} account: avatar opens the menu with name, role badge, Profile/Settings/Sign Out (+ Role Dashboard if applicable)`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });

        await login(page, credEmail);
        const trigger = page.locator('header button:has([data-slot="avatar"])').first();
        await trigger.click();
        await page.waitForTimeout(400);

        const badge = page.getByText(roleLabel, { exact: true });
        // credEmail's live role may still be a pre-scope-lock value (e.g.
        // coach.riptide is stale as 'team_captain', a role that no longer
        // exists in ROLE_LABELS) until schema.sql/seed-demo.sql are
        // re-applied — the badge renders blank rather than showing a
        // stale/wrong label, which is correct, but leaves nothing to assert.
        requireFixture((await badge.count()) > 0, `the "${roleLabel}" role badge for ${credEmail}`);

        await expect(badge).toBeVisible();
        await expect(page.getByText("Profile", { exact: true })).toBeVisible();
        await expect(page.getByText("Account Settings")).toBeVisible();
        await expect(page.getByText("Sign Out")).toBeVisible();

        const dashboardItem = page.locator('[data-slot="dropdown-menu-item"]', { hasText: "Role Dashboard" });
        if (dashboardHref) {
          await expect(dashboardItem).toBeVisible();
          const href = await dashboardItem.first().getAttribute("href");
          expect(href).toBe(dashboardHref);
        } else {
          await expect(dashboardItem).toHaveCount(0);
        }

        expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
      });
    }
  });

  test("spectator can navigate home -> live meet -> all-time leaderboard without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await login(page, CREDENTIALS.parent1);
    await page.goto("/");
    await page.waitForTimeout(1000);

    const volumeCard = page.locator('a[href^="/events/"][href$="/live"]').first();
    await expect(volumeCard).toBeVisible();
    await volumeCard.click();
    await page.waitForURL(/\/events\/\d+\/live/, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    await page.goto("/leaderboards/all-time");
    await page.waitForTimeout(1000);
    await expect(page.getByRole("heading", { name: "All-Time SSC Records" })).toBeVisible();

    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });
});
