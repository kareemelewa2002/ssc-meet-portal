"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/supabase/types";

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  profileImageUrl: string | null;
}

export interface UseCurrentUserResult {
  user: CurrentUser | null;
  loading: boolean;
}

/** Human label for a Role badge on deck portals — "Role: Referee", etc. */
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  referee: "Referee",
  athlete: "Athlete",
  parent: "Parent",
};

// ---------------------------------------------------------------------------
// One shared resolution for the whole page, not one per consumer.
//
// This used to run its own getUser() + onAuthStateChange subscription inside
// every component that called the hook. That is fine on a page with one
// consumer and catastrophic on the referee deck, where HeatResultEntry calls
// it and the deck renders one card per heat: a 40-heat meet meant 40 network
// round-trips to GoTrue on mount, 40 live auth subscriptions, and — because
// every subscriber re-ran the full load() on every auth event — another 40
// concurrent calls each time a token refreshed.
//
// Local GoTrue does not survive that. A Playwright trace of the two-device
// referee spec showed hundreds of GET /auth/v1/user requests degrading to 504
// and then to outright connection failures (-1), which took the page's OTHER
// requests down with them: the referee's own POST /rest/v1/results failed at
// the transport layer, so a saved time never reached the database and the
// second device correctly showed nothing. The header rendered "Sign in" for
// the same reason — getUser() had stopped answering, not the session ending.
//
// So: a module-level store. N consumers share one auth subscription, one
// getUser(), and one profile read.
// ---------------------------------------------------------------------------

type Listener = (state: UseCurrentUserResult) => void;

let sharedState: UseCurrentUserResult = { user: null, loading: true };
const listeners = new Set<Listener>();
let subscription: { unsubscribe: () => void } | null = null;
let inFlight: Promise<void> | null = null;

function publish(next: UseCurrentUserResult) {
  sharedState = next;
  for (const listener of listeners) listener(sharedState);
}

/** Reads the app profile for an already-authenticated user id. */
async function loadProfile(id: string, email: string) {
  const supabase = createClient();
  const { data: profile } = await supabase
    .from("users")
    .select("full_name, role, profile_image_url")
    .eq("id", id)
    .maybeSingle();
  publish({
    user: {
      id,
      email,
      fullName: profile?.full_name ?? email ?? "Signed in",
      role: profile?.role ?? "athlete",
      profileImageUrl: profile?.profile_image_url ?? null,
    },
    loading: false,
  });
}

/** The initial resolution. Deduplicated: consumers mounting together in the
 * same tick share one in-flight request rather than each issuing their own. */
function resolveOnce(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const supabase = createClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    if (!authUser) {
      publish({ user: null, loading: false });
      return;
    }
    await loadProfile(authUser.id, authUser.email ?? "");
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function start() {
  if (subscription) return;
  const supabase = createClient();
  void resolveOnce();
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    // supabase-js emits INITIAL_SESSION right after subscribing, which would
    // otherwise duplicate the resolveOnce() already in flight above.
    if (inFlight) return;
    const nextId = session?.user?.id ?? null;
    const currentId = sharedState.user?.id ?? null;
    // The session the callback hands us is authoritative, so there is no
    // reason to call getUser() again here — and calling into supabase from
    // inside this callback is exactly what turned a token refresh into
    // another round of network traffic from every subscriber at once.
    if (nextId === currentId) return;
    if (!nextId) {
      publish({ user: null, loading: false });
      return;
    }
    void loadProfile(nextId, session?.user?.email ?? "");
  });
  subscription = data.subscription;
}

/** Resolves the signed-in auth user's app profile (name + role) for display
 * on deck portals and route guards. Returns user: null once resolved with no
 * session — never blocks render on a slow network (loading flips false either way). */
export function useCurrentUser(): UseCurrentUserResult {
  const [state, setState] = useState<UseCurrentUserResult>(sharedState);

  useEffect(() => {
    listeners.add(setState);
    start();
    // A consumer mounting after the shared state has already resolved must
    // not sit on the stale `loading: true` it initialised with.
    setState(sharedState);
    return () => {
      listeners.delete(setState);
      if (listeners.size === 0) {
        subscription?.unsubscribe();
        subscription = null;
        // Deliberately NOT resetting sharedState: the resolved user is still
        // correct, and keeping it means a remount renders the right header
        // immediately instead of flashing "Sign in" while it re-resolves.
      }
    };
  }, []);

  return state;
}
