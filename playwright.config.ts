import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

// Some specs (e.g. 07-spectator) need NEXT_PUBLIC_SUPABASE_URL/ANON_KEY to
// look up real seeded ids via PostgREST directly from Node, not just via
// the app running in the browser.
dotenv.config({ path: ".env.local" });

/**
 * macOS 12 (this machine) is below Playwright's bundled-Chromium support
 * floor, so tests launch the system-installed Google Chrome instead via
 * `channel: "chrome"` + an explicit executablePath — a fully supported
 * Playwright configuration, not a workaround unique to this run.
 */
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    actionTimeout: 10_000,
    channel: "chrome",
    launchOptions: {
      executablePath: SYSTEM_CHROME,
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Next dev compiles routes on-demand — the very first hit to any route
    // right after a cold `next dev` start can race ahead of React hydration
    // (the DOM shows the right value, but no onChange listener is attached
    // yet), producing intermittent failures that have nothing to do with
    // the app. Running against the production build removes that whole
    // class of flakiness.
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
