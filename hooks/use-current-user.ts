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

/** Resolves the signed-in auth user's app profile (name + role) for display
 * on deck portals and route guards. Returns user: null once resolved with no
 * session — never blocks render on a slow network (loading flips false either way). */
export function useCurrentUser(): UseCurrentUserResult {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    const load = async () => {
      const {
        data: { user: authUser },
      } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!authUser) {
        setUser(null);
        setLoading(false);
        return;
      }
      const { data: profile } = await supabase
        .from("users")
        .select("full_name, role, profile_image_url")
        .eq("id", authUser.id)
        .maybeSingle();
      if (cancelled) return;
      setUser({
        id: authUser.id,
        email: authUser.email ?? "",
        fullName: profile?.full_name ?? authUser.email ?? "Signed in",
        role: profile?.role ?? "athlete",
        profileImageUrl: profile?.profile_image_url ?? null,
      });
      setLoading(false);
    };

    void load();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void load();
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return { user, loading };
}
