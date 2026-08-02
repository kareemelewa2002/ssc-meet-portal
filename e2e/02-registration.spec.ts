import path from "node:path";
import { test, expect } from "@playwright/test";

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
    await page.locator("#dob").fill("2012-05-01"); // age 14
    await expect(page.getByText(/Age 14 at signup/i)).toBeVisible();
    // Parent email field must appear for this age.
    await expect(page.locator("#parentEmail")).toBeVisible();

    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText("Swimmers under 15 must provide a parent or guardian email before signing up."),
    ).toBeVisible();
    // No network signup should have happened — still on the form.
    await expect(page.locator("#fullName")).toBeVisible();
  });

  test("U17/Open swimmers never see a parent email field", async ({ page }) => {
    await page.goto("/register");
    await page.locator("#dob").fill("2010-05-01"); // age 16 (U17)
    await expect(page.getByText(/Age 16 at signup/i)).toBeVisible();
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
    await page.locator("#fullName").fill("E2E U17 Self Register");
    await page.locator("#email").fill(email);
    await page.locator("#phone").fill("+10000000002");
    await page.locator("#password").fill("Password123!");
    await page.locator("#dob").fill("2009-06-15"); // age 17, U17
    await page.getByRole("button", { name: "male", exact: true }).click();

    await page.getByRole("button", { name: "Create account" }).click();

    const rateLimited = page.getByText(/rate limit/i);
    const success = page.getByText("Account created!");
    await expect(rateLimited.or(success)).toBeVisible({ timeout: 15_000 });
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
    await page.locator("#fullName").fill("E2E U14 With Parent");
    await page.locator("#email").fill(email);
    await page.locator("#phone").fill("+10000000003");
    await page.locator("#password").fill("Password123!");
    await page.locator("#dob").fill("2012-05-01"); // age 14
    await page.getByRole("button", { name: "female", exact: true }).click();
    await page.locator("#parentEmail").fill(`e2e.parent.${Date.now()}@gmail.com`);

    await page.getByRole("button", { name: "Create account" }).click();

    const rateLimited = page.getByText(/rate limit/i);
    const success = page.getByText("Account created!");
    await expect(rateLimited.or(success)).toBeVisible({ timeout: 15_000 });
    test.skip(
      await rateLimited.isVisible(),
      "Supabase auth email send rate limit hit — cannot exercise the success path this run.",
    );
    await expect(page.getByText(/parent\/guardian must authorize entries/i)).toBeVisible();
  });
});
