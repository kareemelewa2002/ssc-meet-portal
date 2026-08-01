import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./types";

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        // "Keep me logged in": the session (and its refresh token) is
        // persisted in cookies and silently refreshed, so a signed-in user
        // stays signed in across browser restarts until they explicitly
        // sign out. These are @supabase/ssr's defaults already — spelled
        // out explicitly so intent survives any future default change.
        persistSession: true,
        autoRefreshToken: true,
      },
    },
  );
}
