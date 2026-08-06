import { test, expect } from "@playwright/test";
import { CREDENTIALS, login, requireFixture } from "./helpers";
import {
  createPendingPaymentFixture,
  createPendingTeamFixture,
  createSubmittedHeatCardFixture,
} from "./fixtures/heat-fixture";

test.describe("Admin dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, CREDENTIALS.admin);
    await page.goto("/admin");
    await page.waitForTimeout(1000);
  });

  test("there is no swimmer-approval queue — accounts need no approval", async ({ page }) => {
    // Approving accounts was removed: paying the entry fee is the gate, and
    // confirming that payment is what seeds the heats.
    await expect(page.getByRole("button", { name: "Pending Swimmer Registrations" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve Swimmer" })).toHaveCount(0);
  });

  test("Pending Team Approvals tab can approve a real pending team", async ({ page }) => {
    // Restored, not assumed: this test APPROVES the seeded pending team, so
    // from the second run onward the fixture it looks for no longer exists
    // and the spec quietly skipped.
    const pending = await createPendingTeamFixture();
    requireFixture(pending !== null, "a team that can be put into the pending state");
    if (!pending) return;

    try {
      await page.goto("/admin");
      // The tab button holds both a mobile shortLabel span and a desktop
      // full-label span, toggled by Tailwind responsive classes — at
      // Playwright's default desktop viewport, the full label is what's
      // actually visible/accessible.
      await page.getByRole("button", { name: "Pending Team Approvals" }).click();
      await page.waitForTimeout(1200);

      // Not `tr`: this queue renders cards, not a table, so the original
      // locator could never match — the fixture guard was masking a test that
      // would have failed the moment it ran.
      const row = page.locator('[data-testid="pending-team-row"]', { hasText: pending.name });
      await expect(row).toBeVisible({ timeout: 10_000 });

      await row.getByRole("button", { name: "Approve Team" }).click();
      await page.waitForTimeout(1500);
      await expect(
        page.locator('[data-testid="pending-team-row"]', { hasText: pending.name }),
      ).toHaveCount(0);
      await expect(page.locator('[data-slot="alert"]')).toHaveCount(0);
    } finally {
      await pending.cleanup();
    }
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
    // Builds its own submitted card. Publishing is what this test does, so
    // relying on a queue populated by earlier runs meant it emptied the queue
    // and then skipped forever after.
    const card = await createSubmittedHeatCardFixture();
    requireFixture(card !== null, "an event with entries to build a submitted heat card from");
    if (!card) return;

    try {
      await page.goto("/admin");
      await page.getByRole("button", { name: "Referee Heat Cards" }).click();
      await page.waitForTimeout(1500);

      const readyCard = page
        .locator('[data-testid="review-heat-card"]', { hasText: `Heat ${card.heatNumber}` })
        .first();
      await expect(readyCard).toBeVisible({ timeout: 10_000 });
      await expect(readyCard.getByText("Draft Heat Card — Ready")).toBeVisible();

      await readyCard.getByRole("button", { name: "Publish Heat Card" }).click();
      await page.waitForTimeout(1500);
      await expect(page.locator('[data-slot="alert"]')).toHaveCount(0);
    } finally {
      await card.cleanup();
    }
  });

  test("Cash Payments tab shows a pending-payment fixture and can confirm it", async ({ page }) => {
    // Confirming is the point of the test, so the pending entry has to be put
    // back rather than found — otherwise the queue drains and this skips.
    const payment = await createPendingPaymentFixture();
    requireFixture(payment !== null, "an entry that can be put into pending_payment");
    if (!payment) return;

    try {
      await page.goto("/admin");
      await page.getByRole("button", { name: "Cash Payments" }).click();
      await page.waitForTimeout(1500);

      const row = page.locator("tbody tr").first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      // The badge names the tier the figure was quoted at, because the amount
      // depends on it and the desk is where the money changes hands.
      await expect(row.getByText(/EGP — (Early Bird|Standard|Late) rate, pending on deck/)).toBeVisible();
      await row.getByRole("button", { name: "Confirm Payment" }).click();
      await page.waitForTimeout(1500);
      await expect(page.locator('[data-slot="alert"]')).toHaveCount(0);
    } finally {
      await payment.cleanup();
    }
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
    // Heats are no longer pre-seeded: they are generated when an admin
    // approves entries. So the button is enabled while work remains and
    // disabled once every individual event has heats — assert the invariant
    // (it matches the actual seeded state) rather than one fixed outcome.
    // Relay events show "Unseeded" permanently by design, so that text says
    // nothing about whether bulk seeding has work to do. The per-event
    // "Seed Single Event" button is the real signal.
    const seedableEvents = await page.getByRole("button", { name: "Seed Single Event" }).count();
    if (seedableEvents > 0) {
      await expect(seedAllButton).toBeEnabled();
    } else {
      await expect(seedAllButton).toBeDisabled();
    }
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
