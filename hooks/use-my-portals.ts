"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";

export interface MyPortals {
  /** The signed-in user's own athlete row, if they have one. */
  athleteId: string | null;
  /** A team points at them via teams.captain_id. */
  captainsTeam: boolean;
  /** Role is 'parent', or athletes.parent_id points at them. */
  isParent: boolean;
  loading: boolean;
}

/**
 * Which role portals this user can actually reach — the question the header
 * and the home page both need in order to offer a link that goes somewhere
 * useful rather than to an empty gate.
 *
 * Captaincy is deliberately "does a team point at me" (teams.captain_id) and
 * NOT public.can_captain_team(). That function answers a different question
 * on purpose — its own comment in schema.sql says so — namely whether someone
 * is ELIGIBLE to found a team, which is true for every Open-age athlete and
 * every admin. Gating the Captain Portal on eligibility would offer it to
 * most of the roster and land them on "No team currently lists you as its
 * captain."
 *
 * Cached per user id at module scope, for the same reason useCurrentUser is:
 * AppHeader renders on every page and the home page calls this too, so a
 * naive implementation would issue these three queries several times per
 * navigation. One resolution per user, shared.
 */
type PortalFacts = Omit<MyPortals, "loading">;

const EMPTY: PortalFacts = { athleteId: null, captainsTeam: false, isParent: false };

let cachedForUserId: string | null = null;
let cached: PortalFacts | null = null;
let inFlight: Promise<PortalFacts> | null = null;

async function resolvePortals(userId: string, role: string): Promise<PortalFacts> {
  if (cachedForUserId === userId && cached) return cached;
  if (inFlight && cachedForUserId === userId) return inFlight;

  cachedForUserId = userId;
  inFlight = (async () => {
    const supabase = createClient();
    const [athlete, captained, children] = await Promise.all([
      supabase.from("athletes").select("id").eq("user_id", userId).maybeSingle(),
      supabase.from("teams").select("id").eq("captain_id", userId).limit(1),
      supabase.from("athletes").select("id").eq("parent_id", userId).limit(1),
    ]);
    const facts: PortalFacts = {
      athleteId: (athlete.data as { id: string } | null)?.id ?? null,
      captainsTeam: ((captained.data as unknown[]) ?? []).length > 0,
      // Role alone is enough: a parent who has not been linked to a child yet
      // still needs the portal, because that is where the linkage shows up.
      isParent: role === "parent" || ((children.data as unknown[]) ?? []).length > 0,
    };
    // Only publish to the shared cache if this is still the current user. A
    // sign-out and sign-in without a page reload can leave the previous
    // account's slower request in flight, and letting it land would cache one
    // person's portals against another's session.
    if (cachedForUserId === userId) cached = facts;
    return facts;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export function useMyPortals(): MyPortals {
  const { user, loading: userLoading } = useCurrentUser();
  const [facts, setFacts] = useState<PortalFacts>(cached ?? EMPTY);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (userLoading) return;
    if (!user) {
      setFacts(EMPTY);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void resolvePortals(user.id, user.role).then((result) => {
      if (cancelled) return;
      setFacts(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user, userLoading]);

  return { ...facts, loading: loading || userLoading };
}
