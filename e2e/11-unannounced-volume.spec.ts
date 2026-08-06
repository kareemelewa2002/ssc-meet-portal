import { test, expect } from "@playwright/test";
import { CREDENTIALS, login } from "./helpers";
import { createClient } from "@supabase/supabase-js";

/**
 * An unannounced meet must not be reachable by guessing its URL.
 *
 * /meets and /leaderboards decide what is LISTED — that alone was never
 * enough, because before app/events/[volId]/layout.tsx existed, typing
 * /events/2/register rendered an unannounced volume's name, sessions and
 * prices to anybody signed in who guessed the number. Absent from an index is
 * not the same as private.
 *
 * WHAT ACTUALLY ENFORCES THIS NOW: not this file, and not the layout either.
 * public.meet_volumes' RLS policy — is_admin() or (is_public and
 * status <> 'planned') — is the single definition of "who may see this
 * volume", and the layout just queries through fetchVolumeByNumber() and
 * treats an empty result as not-found. This suite still only manipulates
 * `status`, which is sufficient on its own here (is_public defaults to false
 * on volume 2 already, so status='planned' alone is enough to prove the
 * "hidden" path) — but it is is_public, not status, that an admin actually
 * flips in normal use. See publish-toggle.spec.ts for coverage of that flag
 * directly, exercised through the Control Unit UI rather than by mutating the
 * database underneath the app.
 */

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

/**
 * Runs `run()` with the given volume in 'planned', and VERIFIES it got there.
 *
 * The verification is the point. .env.test carries no service-role key, so
 * this client is anon, and RLS refuses anon UPDATEs on meet_volumes — the
 * write here is silently discarded. The first version of this helper assumed
 * it had worked; the spec passed only because the seeded volume 2 already
 * happens to be 'planned'. A precondition nobody checked is how a test ends up
 * proving something other than what it claims.
 */
async function withPlannedVolume(
  volumeNumber: number,
  run: () => Promise<void>,
): Promise<void> {
  const supabase = serviceClient();
  const { data: before } = await supabase
    .from("meet_volumes")
    .select("id, status")
    .eq("volume_number", volumeNumber)
    .maybeSingle();

  if (!before) {
    test.skip(true, `no volume ${volumeNumber} seeded`);
    return;
  }

  if (before.status !== "planned") {
    await supabase.from("meet_volumes").update({ status: "planned" }).eq("id", before.id);
  }

  const { data: after } = await supabase
    .from("meet_volumes")
    .select("status")
    .eq("id", before.id)
    .maybeSingle();

  // Fail loudly rather than testing a volume that is not actually hidden.
  expect(
    after?.status,
    `volume ${volumeNumber} must be 'planned' for this spec; RLS may have refused the update (no service-role key in .env.test)`,
  ).toBe("planned");

  try {
    await run();
  } finally {
    if (before.status !== "planned") {
      await supabase
        .from("meet_volumes")
        .update({ status: before.status })
        .eq("id", before.id);
    }
  }
}

test.describe("Unannounced volumes are not reachable by URL", () => {
  test("a signed-out visitor never sees the volume", async ({ page }) => {
    // Asserted as "never sees it", not "gets a 404". Middleware bounces every
    // non-public path to /login before the layout's gate is ever consulted, so
    // a signed-out visitor lands on the sign-in page. That is equally
    // protective, and pinning the status code to 404 would have been asserting
    // an implementation detail this route does not own.
    await withPlannedVolume(2, async () => {
      for (const path of [
        "/events/2/register",
        "/events/2/schedule",
        "/events/2/results",
        "/events/2/leaderboard",
      ]) {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await expect(page.getByText("SSC Vol. 2")).toHaveCount(0);
        expect(
          page.url().includes("/login") || page.url().includes(path),
          `${path} should end on /login or a 404, never on the volume`,
        ).toBe(true);
      }
    });
  });

  test("a signed-in athlete gets a 404 too", async ({ page }) => {
    await withPlannedVolume(2, async () => {
      await login(page, CREDENTIALS.approvedOpen);
      const response = await page.goto("/events/2/register", {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBe(404);
      await expect(page.getByText("SSC Vol. 2")).toHaveCount(0);
    });
  });

  test("an admin CAN open it — they have to build it before it goes public", async ({
    page,
  }) => {
    // The negative control for the two above. A gate that refused everyone
    // would pass those tests and make an unannounced meet impossible to set up.
    await withPlannedVolume(2, async () => {
      await login(page, CREDENTIALS.admin);
      const response = await page.goto("/events/2/schedule", {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBe(200);
    });
  });

  test("an announced volume stays reachable by everyone", async ({ page }) => {
    // The other negative control: proves the gate keys on STATUS rather than
    // quietly 404ing every volume-scoped route.
    const response = await page.goto("/events/1/schedule", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
  });
});
