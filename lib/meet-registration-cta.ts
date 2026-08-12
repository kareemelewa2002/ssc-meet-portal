import { createClient } from "@/lib/supabase/client";
import { fetchActiveVolume } from "@/lib/volumes";
import { fetchMeetSettings, registrationState } from "@/lib/meet-settings";
import type { MeetVolumeRow } from "@/lib/supabase/types";

/**
 * Whether the home page should invite this account to enter the live meet.
 *
 * The rule is deliberately narrow: offer registration only to someone who
 * can actually act on it and has not already. A swimmer already entered does
 * not need to be told to enter, and prompting them would read as "your entry
 * did not go through" — the worst possible message to show someone who has
 * already paid attention to the deadline.
 */
export interface MeetRegistrationCta {
  volume: MeetVolumeRow;
  /** Where the CTA points — /events/<volume_number>/register. */
  href: string;
  /**
   * Athletes on this account with no entry in the live volume. For a swimmer
   * this is themselves or nobody; for a parent it is whichever children are
   * still unentered, so the card can name them rather than saying a vague
   * "someone still needs to register".
   */
  unenteredNames: string[];
  /** True when the account is a parent acting for children rather than a
   * swimmer entering themselves — the wording differs. */
  onBehalfOfChildren: boolean;
}

/**
 * Returns null — meaning "show nothing" — in every case where the invitation
 * would be wrong:
 *
 *   - no live volume, or none the caller can see
 *   - registration not open (before the window, or closed without late entry)
 *   - the account has no athletes at all (a referee, an unlinked admin)
 *   - every athlete on the account is already entered
 *
 * A null is also returned on a query failure. This is a promotional card, not
 * a record: if we cannot establish that someone still needs to register, the
 * honest move is silence rather than a prompt that might be wrong.
 */
export async function fetchMeetRegistrationCta(input: {
  /** The signed-in user's own athlete row, if they are a swimmer. */
  athleteId: string | null;
  /** Athletes linked to this user as their parent. */
  children: { athleteId: string; fullName: string }[];
  /** The signed-in user's own display name, for the self-registration case. */
  ownName: string | null;
}): Promise<MeetRegistrationCta | null> {
  const candidates = [
    ...(input.athleteId
      ? [{ athleteId: input.athleteId, fullName: input.ownName ?? "You" }]
      : []),
    ...input.children,
  ];
  if (candidates.length === 0) return null;

  try {
    const volumeResult = await fetchActiveVolume();
    const volume = volumeResult.data;
    // A demo-fallback volume has no real events to register for, so pointing
    // at its register page would dead-end.
    if (!volume || volume.id.startsWith("demo-")) return null;

    const settings = await fetchMeetSettings(volume.id);
    if (!settings.data) return null;
    if (!registrationState(settings.data).open) return null;

    const supabase = createClient();
    // Which of these athletes already has an entry in THIS volume. Scoped in
    // JS rather than with .eq() on the embed: a filter applied to an embedded
    // relation silently nulls the whole embed in PostgREST, which would make
    // every athlete look unentered.
    const { data, error } = await supabase
      .from("entries")
      .select("athlete_id, events ( sessions ( meet_volume_id ) )")
      .in(
        "athlete_id",
        candidates.map((c) => c.athleteId),
      );
    if (error) return null;

    type Row = {
      athlete_id: string;
      events:
        | { sessions: { meet_volume_id: string } | { meet_volume_id: string }[] | null }
        | { sessions: { meet_volume_id: string } | { meet_volume_id: string }[] | null }[]
        | null;
    };
    const first = <T,>(v: T | T[] | null | undefined): T | null =>
      v == null ? null : Array.isArray(v) ? (v[0] ?? null) : v;

    const entered = new Set<string>();
    for (const row of (data as unknown as Row[] | null) ?? []) {
      const session = first(first(row.events)?.sessions);
      if (session?.meet_volume_id === volume.id) entered.add(row.athlete_id);
    }

    // Every status counts as entered, including hold_expired. A lapsed hold
    // is a registration that already happened and then timed out; the fix for
    // it is the waitlist and the desk, not a fresh entry that would duplicate
    // the first one.
    const unentered = candidates.filter((c) => !entered.has(c.athleteId));
    if (unentered.length === 0) return null;

    return {
      volume,
      href: `/events/${volume.volume_number}/register`,
      unenteredNames: unentered.map((c) => c.fullName),
      onBehalfOfChildren: !input.athleteId || !unentered.some((c) => c.athleteId === input.athleteId),
    };
  } catch {
    return null;
  }
}
