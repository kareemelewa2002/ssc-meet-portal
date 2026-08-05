import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

// Some specs (e.g. 07-spectator) need NEXT_PUBLIC_SUPABASE_URL/ANON_KEY to
// look up real seeded ids via PostgREST directly from Node, not just via
// the app running in the browser.
dotenv.config({ path: ".env.local" });
// .env.test WINS. It points the app at the disposable instance the suite is
// allowed to wipe; .env.local points at the real project and must never be
// what the E2E run talks to. Keeping them in separate files means switching
// targets is a file that exists or does not, rather than an edit that someone
// forgets to undo.
dotenv.config({ path: ".env.test", override: true });

// Strict by default: a missing or consumed fixture FAILS instead of skipping.
// Skips read as passes, which is how this suite stayed green through a total
// heats/heat_lanes outage. Opt out per-run with SSC_E2E_STRICT=0.
process.env.SSC_E2E_STRICT ??= "1";

// The suite resets the database before it runs (see e2e/global-setup.ts), so
// every spec starts from supabase/seed-demo.sql.
const SKIP_RESET = process.env.SSC_E2E_SKIP_RESET === "1";

/**
 * macOS 12 (this machine) is below Playwright's bundled-Chromium support
 * floor, so tests launch the system-installed Google Chrome instead via
 * `channel: "chrome"` + an explicit executablePath — a fully supported
 * Playwright configuration, not a workaround unique to this run.
 */
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: SKIP_RESET ? undefined : "./e2e/global-setup.ts",
  // Played-meet state loads a full heat deck + Skins boards; 45s was too
  // tight once seed-played-meet advances past pending_payment.
  timeout: 90_000,
  expect: { timeout: 15_000 },
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
    // NEXT_PUBLIC_* values are inlined at BUILD time, so the build must happen
    // with the test environment already loaded — passing it here rather than
    // relying on the server picking up .env.local.
    env: {
      ...(process.env as Record<string, string>),
    },
    // Next dev compiles routes on-demand — the very first hit to any route
    // right after a cold `next dev` start can race ahead of React hydration
    // (the DOM shows the right value, but no onChange listener is attached
    // yet), producing intermittent failures that have nothing to do with
    // the app. Running against the production build removes that whole
    // class of flakiness.
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    // NEVER reuse a server already on :3000.
    //
    // Reusing one cost a full 56-minute run: a next-server left over from an
    // earlier session was still holding the port, so Playwright skipped the
    // build and ran the whole suite against that process. It was serving an
    // OLD build, and once `.next` on disk was replaced its chunk manifest went
    // stale — every page died with "Loading chunk NNNN failed", and 43 specs
    // failed for a reason that had nothing to do with the code under test.
    //
    // This is the same rule as the database reset in e2e/global-setup.ts:
    // a suite run against state nobody verified proves nothing. Failing loudly
    // on a busy port is the point — kill the squatter and run again.
    reuseExistingServer: false,
    // A cold production build (no .next cache) exceeds 3 minutes on this
    // machine, and switching between the live and test environments always
    // invalidates that cache because NEXT_PUBLIC_* is inlined at build time.
    timeout: 600_000,
  },
});
