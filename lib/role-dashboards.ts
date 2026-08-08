import type { UserRole } from "@/lib/supabase/types";

/**
 * Roles that have a dedicated dashboard behind the "Role Dashboard" link.
 *
 * Single source of truth on purpose: the AppHeader dropdown and the Profile
 * page both render that link, and while they each kept their own copy of this
 * map the two drifted — app/parent/page.tsx shipped and was listed on the
 * profile page, but the header's copy never gained the `parent` entry, so the
 * menu a parent actually uses had no way to reach it.
 *
 * Athletes are deliberately absent: /dashboard is reached from the home page,
 * and captaincy is a relationship (teams.captain_id) rather than a role, so
 * /captain cannot be keyed off user.role at all.
 */
export const ROLE_DASHBOARD_HREF: Partial<Record<UserRole, string>> = {
  admin: "/admin",
  referee: "/referee",
  parent: "/parent",
};
