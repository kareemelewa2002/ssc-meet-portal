import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import { firstOf } from "@/lib/live-heats";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// A parent may have more than one linked child (athletes.parent_id) — the
// existing e2e fixtures already assume this (parent1-3 each have 4 linked
// children), but nothing in the app ever listed them: fetchAthleteProfile
// works per-athlete-id, and a parent had no index of "my children" to click
// through from. This is that index, deliberately array-returning everywhere
// rather than assuming exactly one child anywhere in its own logic.
// ---------------------------------------------------------------------------

export interface LinkedChildCard {
  athleteId: string;
  fullName: string;
  age: number;
  ageGroup: AgeGroup;
  gender: Gender;
  teamName: string | null;
  profileImageUrl: string | null;
}

/** Every athlete linked to the signed-in parent. RLS (athlete_view_own_row)
 * already grants a parent SELECT on every athlete row where
 * parent_id = auth.uid(), with no age restriction — the age<15 gate in
 * owns_athlete() only governs WRITE access, not this read. */
export async function fetchMyLinkedChildren(): Promise<FetchResult<LinkedChildCard[]>> {
  const supabase = createClient();
  return runQuery<LinkedChildCard[]>(
    "Loading your linked children",
    async () => {
      const { data: authData } = await supabase.auth.getUser();
      const parentId = authData.user?.id;
      if (!parentId) return { data: [], error: null };

      const { data, error } = await supabase
        .from("athletes")
        .select(
          "id, age, age_group, gender, users!athletes_user_id_fkey ( full_name, profile_image_url ), teams ( name )",
        )
        .eq("parent_id", parentId);
      if (error) return { data: null, error };

      type RawUserEmbed = { full_name: string; profile_image_url: string | null };
      type RawTeamEmbed = { name: string };
      type RawChildRow = {
        id: string;
        age: number;
        age_group: AgeGroup;
        gender: Gender;
        users: RawUserEmbed | RawUserEmbed[] | null;
        teams: RawTeamEmbed | RawTeamEmbed[] | null;
      };

      const children: LinkedChildCard[] = ((data as unknown as RawChildRow[] | null) ?? []).map(
        (row) => {
          const user = firstOf(row.users);
          const team = firstOf(row.teams);
          return {
            athleteId: row.id,
            fullName: user?.full_name ?? "Athlete",
            age: row.age,
            ageGroup: row.age_group,
            gender: row.gender,
            teamName: team?.name ?? null,
            profileImageUrl: user?.profile_image_url ?? null,
          };
        },
      );
      return { data: children, error: null };
    },
    { empty: [] },
  );
}
