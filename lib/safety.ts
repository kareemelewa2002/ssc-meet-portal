import { createClient } from "@/lib/supabase/client";
import { describeError, failure, ok, type FetchResult } from "@/lib/fetch-policy";
import type { AgeGroup } from "@/lib/supabase/types";

export interface PendingSafetyAcceptance {
  athleteId: string;
  fullName: string;
  ageGroup: AgeGroup;
}

/**
 * U14 swimmers linked to the signed-in parent whose safety & privacy
 * acknowledgement is still outstanding.
 *
 * A minor cannot waive their own liability, so this list is the only route by
 * which a U14's acknowledgement can ever be recorded — the registration form
 * deliberately refuses to accept it on their behalf.
 */
export async function fetchPendingSafetyAcceptances(): Promise<
  FetchResult<PendingSafetyAcceptance[]>
> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("my_pending_safety_acceptances");
    if (error) return failure(describeError("Loading safety acknowledgements", error), []);
    return ok(
      (data ?? []).map((r) => ({
        athleteId: r.athlete_id,
        fullName: r.full_name,
        ageGroup: r.age_group,
      })),
    );
  } catch (err) {
    return failure(describeError("Loading safety acknowledgements", err), []);
  }
}

export async function acceptSafetyAcknowledgement(
  athleteId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.rpc("accept_safety_acknowledgement", {
    p_athlete_id: athleteId,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}
