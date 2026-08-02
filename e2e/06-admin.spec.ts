import { test, expect } from "@playwright/test";
import { CREDENTIALS, login } from "./helpers";

test.describe("Admin dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, CREDENTIALS.admin);
    await page.goto("/admin");
    await page.waitForTimeout(1000);
  });

  test("Pending Swimmer Registrations tab renders without error (row or honest empty state)", async ({ page }) => {
    await expect(page.locator('[data-slot="card-title"]', { hasText: "Pending swimmer registrations" })).toBeVisible();
    // Either a real pending row or the explicit empty-state message —
    // never a silently blank card, and never the old hardcoded demo
    // fixture names ("Jordan Blake" / "Sasha Okonkwo").
    await page.waitForTimeout(1000);
    const bodyText = await page.locator("main").innerText();
    expect(bodyText).not.toContain("Jordan Blake");
    expect(bodyText).not.toContain("Sasha Okonkwo");
    const hasEmptyState = bodyText.includes("No pending swimmer registrations.");
    const hasApproveButton = await page.getByRole("button", { name: "Approve Swimmer" }).count();
    expect(hasEmptyState || hasApproveButton > 0).toBe(true);
  });

  test("Pending Club Approvals tab can approve a real pending club", async ({ page }) => {
    // The tab button holds both a mobile shortLabel span and a desktop
    // full-label span, toggled by Tailwind responsive classes — at
    // Playwright's default desktop viewport, the full label is what's
    // actually visible/accessible.
    await page.getByRole("button", { name: "Pending Club Approvals" }).click();
    await page.waitForTimeout(800);

    const row = page.locator("tr", { hasText: "Sunburst Aquatics" });
    test.skip(
      (await row.count()) === 0,
      "Sunburst Aquatics (the seeded pending club fixture) isn't in the live database yet — " +
        "re-apply the updated supabase/seed-demo.sql to exercise this test.",
    );

    await row.getByRole("button", { name: "Approve Club" }).click();
    await page.waitForTimeout(1000);
    await expect(page.locator("tr", { hasText: "Sunburst Aquatics" })).toHaveCount(0);
    await expect(page.locator('[data-slot="alert"]')).toHaveCount(0);
  });

  test("User & Role Management tab loads without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await page.getByRole("button", { name: "User & Role Management" }).click();
    await page.waitForTimeout(1000);
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });

  test("Referee Heat Cards tab shows submitted drafts and can publish one", async ({ page }) => {
    await page.getByRole("button", { name: "Referee Heat Cards" }).click();
    await page.waitForTimeout(1200);

    const publishButtons = page.getByRole("button", { name: "Publish Heat Card" });
    test.skip(!(await publishButtons.count()), "No referee-submitted draft heat cards waiting for review.");

    // Scoped to the specific heat-card container class — an unscoped
    // "div" + hasText locator matches every ancestor div up the tree too.
    const readyCard = page
      .locator(".space-y-3.rounded-lg.border.p-3", { hasText: "Draft Heat Card — Ready" })
      .first();
    const readyPublish = readyCard.getByRole("button", { name: "Publish Heat Card" });
    test.skip(!(await readyPublish.count()), "No fully-complete draft heat cards ready to publish.");

    await readyPublish.click();
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-slot="alert"]')).toHaveCount(0);
  });

  test("Cash Payments tab shows the seeded pending-payment fixture and can confirm it", async ({ page }) => {
    await page.getByRole("button", { name: "Cash Payments" }).click();
    await page.waitForTimeout(1200);

    const row = page.locator("tr", { hasText: "athlete02" });
    const anyRow = page.locator("tbody tr").first();
    const hasAnyRow = (await page.locator("tbody tr").count()) > 0;
    test.skip(!hasAnyRow, "No cash payments pending — seed-demo.sql needs re-applying for athlete02's fixture.");

    const target = (await row.count()) ? row : anyRow;
    await expect(target.getByText(/Cash Payment Pending on Deck/)).toBeVisible();
    await target.getByRole("button", { name: "Cash Payment Received" }).click();
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-slot="alert"]')).toHaveCount(0);
  });
});

test.describe("Seeding dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, CREDENTIALS.admin);
    await page.goto("/admin/seeding");
    await page.waitForTimeout(1500);
  });

  test("relay events show Unseeded permanently, with no Seed or Preview buttons (relay guard)", async ({ page }) => {
    const relayCard = page.locator('[data-slot="card"]', { hasText: "Relay (no individual entries)" }).first();
    await expect(relayCard).toBeVisible();
    const cardText = await relayCard.innerText();
    expect(cardText).toContain("Unseeded");
    await expect(relayCard.getByRole("button", { name: "Seed Single Event" })).toHaveCount(0);
    await expect(relayCard.getByRole("button", { name: "Preview Heat Sheet" })).toHaveCount(0);
    await expect(relayCard.getByRole("button", { name: "Publish Heat Sheet" })).toHaveCount(0);
  });

  test("Preview Heat Sheet shows real seeded athlete names, not placeholders", async ({ page }) => {
    await page.getByRole("button", { name: "Preview Heat Sheet" }).first().click();
    await page.waitForTimeout(800);
    const previewText = await page.locator("main").innerText();
    expect(previewText).toMatch(/Heat \d/);
    // Every lane must resolve to a real full name (two capitalized words) —
    // an unresolved athlete embed would render as the fallback "—" instead.
    expect(previewText).toMatch(/[A-Z][a-z]+(?:'[A-Z][a-z]+)? [A-Z][a-z]+/);
    expect(previewText).not.toMatch(/\bL[1-6]\s*\n\s*—/);
  });

  test("Seed Entire Session is disabled once every non-relay/non-skins event is already seeded", async ({ page }) => {
    const seedAllButton = page.getByRole("button", { name: "Seed Entire Session" });
    await expect(seedAllButton).toBeVisible();
    // Session 1's individual events are fully published in the seed data —
    // nothing left to bulk-seed, so the button must reflect that.
    await expect(seedAllButton).toBeDisabled();
  });

  test("Session 3 (Skins) tab is reachable without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.getByRole("tab", { name: /Session 3/ }).click().catch(async () => {
      await page.getByText("Session 3 — Skins").click();
    });
    await page.waitForTimeout(1000);
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });
});
