import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/**
 * A Supabase client holding the SERVICE ROLE key, which bypasses row level
 * security entirely.
 *
 * `import "server-only"` at the top is not decoration. This key can read every
 * row in the database and write anything; if a client component ever imports
 * this file, the build fails rather than shipping the key to a browser. That
 * is the entire safety mechanism, so do not remove it.
 *
 * Used by exactly two things, both route handlers:
 *   * /api/notifications/dispatch — reads public.email_outbox, which has no
 *     RLS policy granting anyone access. It holds message bodies and recipient
 *     addresses, so nothing signed in as a user should be able to read it.
 *   * /api/cron/process-expired-holds — runs the sweep on behalf of no user.
 *
 * Everything else in the app talks to Supabase as the signed-in user, through
 * lib/supabase/client.ts or server.ts, with RLS doing its job.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    // Thrown rather than returning a half-configured client: a silent failure
    // here would look like "no email to send" forever, which is exactly the
    // kind of quiet nothing that goes unnoticed for weeks.
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL must both be set for server-side jobs.",
    );
  }

  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
