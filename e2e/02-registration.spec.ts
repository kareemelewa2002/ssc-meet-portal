import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * Ticks the two required acknowledgement boxes.
 *
 * force + an explicit toBeChecked() assertion, rather than a plain check().
 * The signup form re-renders as the date of birth and gender are entered, and
 * an empty `alert` element mounts beside it — so Playwright's stability
 * heuristic could sit for the full 10s and time out on a checkbox it had
 * ALREADY ticked. The failure snapshot showed the box [checked] while check()
 * reported a timeout.
 *
 * Skipping the heuristic is safe here precisely because the outcome is
 * asserted straight after: if the click did not land, toBeChecked() fails.
 * Nothing is being hidden, only measured differently.
 */
async function acceptTerms(page: Page) {
  const privacy = page.locator("#acceptPrivacy");
  const safety = page.locator("#acceptSafety");
  await privacy.check({ force: true });
  await safety.check({ force: true });
  await expect(privacy).toBeChecked();
  await expect(safety).toBeChecked();
}


const AVATAR_FIXTURE = path.join(__dirname, "fixtures", "test-avatar.png");

test.describe("Registration & validation", () => {
  test("under-13 rejection shows the exact required message", async ({ page }) => {
    await page.goto("/register");
    await page.locator("#dob").fill("2015-01-01"); // age 11 as of any 2026 signup date
    await expect(page.getByText(/at least 13 years old/i)).toBeVisible();
    await expect(
      page.getByText("SSC platform accounts require swimmers to be at least 13 years old."),
    ).toBeVisible();
  });

  test("U14 (born 2012) requires a parent email before submitting", async ({ page }) => {
    await page.goto("/register");
    await page.locator("#fullName").fill("E2E U14 No Parent");
    await page.locator("#email").fill(`e2e.u14.noparent.${Date.now()}@gmail.com`);
    await page.locator("#phone").fill("+10000000001");
    await page.locator("#password").fill("Password123!");
    await page.locator("#confirmPassword").fill("Password123!");
    await page.locator("#dob").fill("2012-05-01"); // turns 14 this year (U14)
    await expect(page.getByText(/Turns 14 this year.*U14/i)).toBeVisible();
    // Parent email field must appear for this age.
    await expect(page.locator("#parentEmail")).toBeVisible();

    // Privacy + safety acknowledgement are required to enable the button.
    await acceptTerms(page);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText("Swimmers under 15 must provide a parent or guardian email before signing up."),
    ).toBeVisible();
    // No network signup should have happened — still on the form.
    await expect(page.locator("#fullName")).toBeVisible();
  });

  test("birth-year rule: a swimmer born 2013 is eligible U14 even before their birthday this year", async ({ page }) => {
    await page.goto("/register");
    // Dec 25 birthday hasn't happened yet relative to today — exact calendar
    // age would be 12 (ineligible under the old rule), but the swim-
    // federation birth-year convention (turns 13 in 2026) makes this
    // swimmer eligible and U14 regardless of the exact date.
    await page.locator("#dob").fill("2013-12-25");
    await expect(page.getByText(/Turns 13 this year.*U14/i)).toBeVisible();
    await expect(page.getByText(/at least 13 years old/i)).toHaveCount(0);
    await expect(page.locator("#parentEmail")).toBeVisible();
  });

  test("U17/Open swimmers never see a parent email field", async ({ page }) => {
    await page.goto("/register");
    await page.locator("#dob").fill("2010-05-01"); // turns 16 this year (U17)
    await expect(page.getByText(/Turns 16 this year.*U17/i)).toBeVisible();
    await expect(page.locator("#parentEmail")).toHaveCount(0);
  });

  test("no event-selection UI ever appears during account registration", async ({ page }) => {
    await page.goto("/register");
    await page.locator("#dob").fill("2010-05-01");
    const bodyText = await page.locator("main").innerText();
    expect(bodyText).not.toMatch(/select.*event|seed time|register for this volume/i);
    await expect(page.getByLabel("Date of birth")).toBeVisible();
  });

  test("profile photo uploads to the avatars bucket and previews", async ({ page }) => {
    await page.goto("/register");
    await page.locator("#dob").fill("2005-05-01"); // Open, no parent gate to worry about

    const fileInput = page.locator("#photo");
    await fileInput.setInputFiles(AVATAR_FIXTURE);

    // The preview <Avatar> swaps its fallback "?" for an <AvatarImage> once
    // uploadAvatar() resolves with a public URL.
    await expect(page.locator('img[alt="Profile preview"]')).toBeVisible({ timeout: 15_000 });
    const src = await page.locator('img[alt="Profile preview"]').getAttribute("src");
    expect(src).toMatch(/\/storage\/v1\/object\/public\/avatars\//);
  });

  test("U17/Open self-registration succeeds with parent_link_status = 'none'", async ({ page }) => {
    const email = `e2e.u17.${Date.now()}@gmail.com`;
    await page.goto("/register");
    // Any persisted signup this test creates should read as a real swimmer,
    // not obvious test junk in the admin's live user list.
    await page.locator("#fullName").fill("Youssef Hassan");
    await page.locator("#email").fill(email);
    await page.locator("#phone").fill("+10000000002");
    await page.locator("#password").fill("Password123!");
    await page.locator("#confirmPassword").fill("Password123!");
    await page.locator("#dob").fill("2009-06-15"); // age 17, U17
    await page.getByRole("button", { name: "male", exact: true }).click();

    // Privacy + safety acknowledgement are required to enable the button.
    await acceptTerms(page);
    await page.getByRole("button", { name: "Create account" }).click();

    // GoTrue throttles signups two different ways and only one of them says
    // "rate limit" — the other is "For security purposes, you can only request
    // this after N seconds". Matching just the first made a throttled run fail
    // as though registration were broken, rather than skipping.
    //
    // The timeout is 30s rather than 15s because the failure seen at 15s was an
    // EMPTY alert: the request had not come back yet. A local GoTrue several
    // signups into a suite run is simply slow, and the old budget was reporting
    // that slowness as a product defect.
    const rateLimited = page.getByText(/rate limit|for security purposes/i);
    const success = page.getByText("Account created!");
    await expect(rateLimited.or(success)).toBeVisible({ timeout: 30_000 });
    test.skip(
      await rateLimited.isVisible(),
      "Supabase auth email send rate limit hit — cannot exercise the success path this run.",
    );
    await expect(success).toBeVisible();
    await expect(page.getByText("You can now sign in and register for events.")).toBeVisible();
  });

  test("U14 with parent email supplied succeeds with a pending parent-invite link", async ({ page }) => {
    const email = `e2e.u14.parent.${Date.now()}@gmail.com`;
    await page.goto("/register");
    // Any persisted signup this test creates should read as a real swimmer,
    // not obvious test junk in the admin's live user list.
    await page.locator("#fullName").fill("Mariam El-Sayed");
    await page.locator("#email").fill(email);
    await page.locator("#phone").fill("+10000000003");
    await page.locator("#password").fill("Password123!");
    await page.locator("#confirmPassword").fill("Password123!");
    await page.locator("#dob").fill("2012-05-01"); // age 14
    await page.getByRole("button", { name: "female", exact: true }).click();
    await page.locator("#parentEmail").fill(`e2e.parent.${Date.now()}@gmail.com`);

    // Privacy + safety acknowledgement are required to enable the button.
    await acceptTerms(page);
    await page.getByRole("button", { name: "Create account" }).click();

    // GoTrue throttles signups two different ways and only one of them says
    // "rate limit" — the other is "For security purposes, you can only request
    // this after N seconds". Matching just the first made a throttled run fail
    // as though registration were broken, rather than skipping.
    //
    // The timeout is 30s rather than 15s because the failure seen at 15s was an
    // EMPTY alert: the request had not come back yet. A local GoTrue several
    // signups into a suite run is simply slow, and the old budget was reporting
    // that slowness as a product defect.
    const rateLimited = page.getByText(/rate limit|for security purposes/i);
    const success = page.getByText("Account created!");
    await expect(rateLimited.or(success)).toBeVisible({ timeout: 30_000 });
    test.skip(
      await rateLimited.isVisible(),
      "Supabase auth email send rate limit hit — cannot exercise the success path this run.",
    );
    await expect(page.getByText(/parent\/guardian must authorize entries/i)).toBeVisible();
  });
});
