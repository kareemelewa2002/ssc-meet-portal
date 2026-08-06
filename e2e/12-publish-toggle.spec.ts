import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { CREDENTIALS, login } from "./helpers";

/**
 * The Control Unit's "Publish to clients" toggle, exercised through the real
 * UI rather than by writing is_public directly to the database.
 *
 * e2e/11-unannounced-volume.spec.ts proves the RLS gate itself holds; this
 * proves the admin-facing control an operator actually uses to flip it does
 * the right thing, including the one case that is easy to get wrong: turning
 * is_public on for a volume that is still 'planned' must NOT make it appear
 * anywhere, and the UI has to say so rather than implying the meet just went
 * live.
 *
 * Volume 2 is used throughout — it is the one genuinely intended to stay
 * hidden pending client agreement, and it starts every run at
 * status='planned', is_public=false. Both are restored in `finally`.
 */

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

async function volumeRow(volumeNumber: number) {
  const { data } = await serviceClient()
    .from("meet_volumes")
    .select("id, status, is_public")
    .eq("volume_number", volumeNumber)
    .maybeSingle();
  return data;
}

test.describe("Publishing a meet from the Control Unit", () => {
  test("publishing a still-planned volume flips is_public but says it stays hidden", async ({
    page,
  }) => {
    const before = await volumeRow(2);
    test.skip(!before, "no volume 2 seeded");
    test.skip(before?.status !== "planned", "volume 2 is not 'planned' right now — skipping rather than mutating a state another test may depend on");

    try {
      await login(page, CREDENTIALS.admin);
      await page.goto("/admin/control-unit", { waitUntil: "domcontentloaded" });

      const select = page.locator("#volume-select");
      await expect(select).toBeVisible({ timeout: 20_000 });
      await select.selectOption(before!.id);

      const publishButton = page.getByRole("button", { name: "Publish to clients" });
      await expect(publishButton).toBeVisible({ timeout: 10_000 });
      await publishButton.click();

      // The specific, easy-to-get-wrong case: is_public flips true, but the
      // toast has to say the meet is STILL hidden because it is 'planned' —
      // not "published", which would be a lie.
      await expect(page.getByText(/stays hidden while it is still 'planned'/i)).toBeVisible({
        timeout: 10_000,
      });

      const after = await volumeRow(2);
      expect(after?.is_public).toBe(true);
      expect(after?.status).toBe("planned");
    } finally {
      await serviceClient()
        .from("meet_volumes")
        .update({ is_public: false })
        .eq("volume_number", 2);
    }
  });

  test("publishing a scheduled volume makes it appear on /meets for everyone", async ({
    page,
    browser,
  }) => {
    const before = await volumeRow(2);
    test.skip(!before, "no volume 2 seeded");

    // Scheduling has no UI yet — this sets up the PRECONDITION the toggle
    // needs (a real date, not just a flag), so the test can exercise the
    // actual UI control for the one piece that does have one: is_public.
    await serviceClient()
      .from("meet_volumes")
      .update({ status: "scheduled", meet_date: "2027-01-01" })
      .eq("volume_number", 2);

    try {
      await login(page, CREDENTIALS.admin);
      await page.goto("/admin/control-unit", { waitUntil: "domcontentloaded" });

      const select = page.locator("#volume-select");
      await expect(select).toBeVisible({ timeout: 20_000 });
      await select.selectOption(before!.id);

      const publishButton = page.getByRole("button", { name: "Publish to clients" });
      await expect(publishButton).toBeVisible({ timeout: 10_000 });
      await publishButton.click();

      await expect(page.getByText(/now visible on \/meets/i)).toBeVisible({ timeout: 10_000 });

      // NOT a signed-out visitor: middleware redirects every path except
      // /login and /register to the sign-in form regardless of session, so an
      // anonymous context never reaches /meets' content at all — it would
      // silently pass this assertion by landing on the login page instead of
      // proving anything about is_public. A plain signed-in athlete, in a
      // fresh context so it shares no session with the admin above, is the
      // actual population this flag governs.
      const otherContext = await browser.newContext();
      const otherPage = await otherContext.newPage();
      try {
        await login(otherPage, CREDENTIALS.approvedU14);
        await otherPage.goto("/meets", { waitUntil: "domcontentloaded" });
        await expect(otherPage.getByText("SSC Vol. 2")).toBeVisible({ timeout: 15_000 });
      } finally {
        await otherContext.close();
      }
    } finally {
      await serviceClient()
        .from("meet_volumes")
        .update({ status: "planned", is_public: false, meet_date: null })
        .eq("volume_number", 2);
    }
  });
});
