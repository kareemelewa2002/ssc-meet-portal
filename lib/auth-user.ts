import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolves "who is asking" for the lib helpers that scope a query to the
 * signed-in user.
 *
 * Every one of those helpers used to call supabase.auth.getUser() itself,
 * which is a network round-trip to GoTrue on each invocation. A component
 * that already holds the user (via useCurrentUser(), which resolves once per
 * page and is shared across consumers) can now pass the id straight through
 * and skip the call entirely.
 *
 * The parameter is optional rather than required on purpose: these helpers
 * are called from a lot of places, and a signature that forces every caller
 * to thread an id would either churn all of them at once or tempt callers
 * into passing something they had not actually verified. Omitting it keeps
 * the old, self-sufficient behaviour.
 *
 * Note the security posture is unchanged either way. None of this is a trust
 * boundary: the id only shapes which rows the client ASKS for, and RLS
 * decides what it may actually see. Passing someone else's id here gets you
 * an empty result, not their data.
 */
export async function resolveUserId(
  supabase: SupabaseClient,
  userId?: string,
): Promise<string | null> {
  if (userId) return userId;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}
