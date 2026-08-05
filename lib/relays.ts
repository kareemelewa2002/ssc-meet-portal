import { createClient } from "@/lib/supabase/client";
import { ok, runQuery, type FetchResult } from "@/lib/fetch-policy";
import type { AgeGroup, EntryStatus, Gender } from "@/lib/supabase/types";

export const RELAY_LEGS = 4;

/**
 * Medley relays swim a fixed Back / Breast / Fly / Free order, so the leg
 * number IS the stroke and the captain's only choice is who takes each leg.
 * Mirrors public.relay_leg_stroke().
 */
export const MEDLEY_LEG_STROKES = [
  "Backstroke",
  "Breaststroke",
  "Butterfly",
  "Freestyle",
] as const;

/** True for both the 4x50 medley relays and the 4x100 individual medley
 * relay — the latter is a medley relay with 100m legs, not four full IMs. */
export function isMedleyRelay(eventStroke: string): boolean {
  return /medley/i.test(eventStroke);
}

/** The stroke a leg swims, or null on a freestyle relay where the leg number
 * is only swim order. */
export function legStroke(eventStroke: string, legNumber: number): string | null {
  if (!isMedleyRelay(eventStroke)) return null;
  return MEDLEY_LEG_STROKES[legNumber - 1] ?? null;
}

export interface GenderRequirement {
  male: number;
  female: number;
}

/**
 * How many swimmers of each gender an event needs, read from the event NAME
 * because that is where the programme states it. Every mixed relay is exactly
 * 2 + 2 — the two spellings in the programme ("(Mixed)" and "(Mixed: 2 Boys +
 * 2 Girls)") mean the same thing. Mirrors public.relay_gender_requirement().
 */
export function genderRequirement(eventName: string): GenderRequirement {
  if (/\(male/i.test(eventName)) return { male: RELAY_LEGS, female: 0 };
  if (/\(female/i.test(eventName)) return { male: 0, female: RELAY_LEGS };
  return { male: 2, female: 2 };
}

/** One race fee per swimmer, so a full squad is four fees.
 * `relayPriceEgp` is meet_settings.relay_event_price_egp — per SWIMMER, which
 * is why it multiplies by the leg count rather than standing alone. */
export function relaySquadFeeEgp(relayPriceEgp: number, legCount: number = RELAY_LEGS): number {
  return legCount * relayPriceEgp;
}

/** A..Z by creation order within (event, team). */
export function nextSquadLetter(existingLetters: string[]): string {
  const used = new Set(existingLetters.map((l) => l.toUpperCase()));
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return letter;
  }
  // 26 squads in one event is not a real scenario, but silently reusing a
  // letter would break the unique constraint with a raw 409.
  return `A${existingLetters.length + 1}`;
}

export interface RelayCandidate {
  athleteId: string;
  fullName: string;
  gender: Gender;
  ageGroup: AgeGroup;
  /** False when they have no individual entry in this meet volume. */
  enteredInMeet: boolean;
  /** Squad letter they already swim in for THIS event, if any. */
  takenBySquad: string | null;
}

export interface RelaySquadDraft {
  eventName: string;
  ageGroup: AgeGroup;
  /** athleteId per leg, index 0 = leg 1. Nulls are unfilled legs. */
  legs: (string | null)[];
}

export interface RelayValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Mirrors public.validate_relay_squad() so the captain sees why a squad is
 * not valid while they build it, rather than on submit.
 *
 * This is a MIRROR, not the enforcement. The database refuses a bad squad
 * whatever the UI believes — see the constraint trigger, which is deferred to
 * commit precisely because these rules are about the squad as a whole and
 * cannot be judged one leg at a time.
 */
export function validateSquad(
  draft: RelaySquadDraft,
  candidates: RelayCandidate[],
): RelayValidation {
  const errors: string[] = [];
  const byId = new Map(candidates.map((c) => [c.athleteId, c]));
  const chosen = draft.legs.filter((id): id is string => id !== null);

  if (chosen.length !== RELAY_LEGS) {
    errors.push(`Pick ${RELAY_LEGS} swimmers — ${chosen.length} chosen so far.`);
  }

  if (new Set(chosen).size !== chosen.length) {
    errors.push("The same swimmer cannot swim two legs of one relay.");
  }

  const picked = chosen.map((id) => byId.get(id)).filter((c): c is RelayCandidate => !!c);

  const wrongAge = picked.filter((c) => c.ageGroup !== draft.ageGroup);
  if (wrongAge.length > 0) {
    errors.push(
      `All four swimmers must be in this squad's age group. ${wrongAge
        .map((c) => c.fullName)
        .join(", ")} ${wrongAge.length === 1 ? "is" : "are"} not.`,
    );
  }

  const notEntered = picked.filter((c) => !c.enteredInMeet);
  if (notEntered.length > 0) {
    errors.push(
      `${notEntered
        .map((c) => c.fullName)
        .join(", ")} ${notEntered.length === 1 ? "is" : "are"} not entered in this meet. Relay swimmers must already have an individual entry.`,
    );
  }

  const taken = picked.filter((c) => c.takenBySquad !== null);
  if (taken.length > 0) {
    errors.push(
      taken
        .map((c) => `${c.fullName} already swims this relay in squad ${c.takenBySquad}.`)
        .join(" "),
    );
  }

  // Only judged once the squad is full — reporting "needs 2 male, has 1"
  // while somebody is still picking is noise, not a problem.
  if (chosen.length === RELAY_LEGS) {
    const need = genderRequirement(draft.eventName);
    const male = picked.filter((c) => c.gender === "male").length;
    const female = picked.filter((c) => c.gender === "female").length;
    if (male !== need.male || female !== need.female) {
      errors.push(
        `${draft.eventName} needs ${need.male} male and ${need.female} female swimmers — this squad has ${male} male, ${female} female.`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export interface RelayEvent {
  id: string;
  name: string;
  stroke: string;
  distanceM: number;
  sessionNumber: number;
}

export interface RelaySquadView {
  id: string;
  eventId: string;
  eventName: string;
  eventStroke: string;
  teamId: string;
  ageGroup: AgeGroup;
  squadLetter: string;
  status: EntryStatus;
  legs: { legNumber: number; athleteId: string; athleteName: string; stroke: string | null }[];
}

/** The teams this user captains. Captaincy is a relationship, not a role. */
export async function fetchCaptainedTeams(): Promise<
  FetchResult<{ id: string; name: string }[]>
> {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return ok([]);

  return runQuery<{ id: string; name: string }[]>(
    "Loading the teams you captain",
    async () =>
      supabase.from("teams").select("id, name").eq("captain_id", auth.user!.id).order("name"),
    { empty: [] },
  );
}

export async function fetchRelayEvents(meetVolumeId: string): Promise<FetchResult<RelayEvent[]>> {
  const supabase = createClient();
  const sessions = await runQuery<{ id: string; session_number: number }[]>(
    "Loading meet sessions",
    async () =>
      supabase.from("sessions").select("id, session_number").eq("meet_volume_id", meetVolumeId),
    { empty: [] },
  );
  if (sessions.data.length === 0) return { ...sessions, data: [] };

  const numberById = new Map(sessions.data.map((s) => [s.id, s.session_number]));
  const events = await runQuery<
    { id: string; name: string; stroke: string; distance_m: number; session_id: string }[]
  >(
    "Loading relay events",
    async () =>
      supabase
        .from("events")
        .select("id, name, stroke, distance_m, session_id")
        .in("session_id", sessions.data.map((s) => s.id))
        .eq("is_relay", true)
        .order("event_order", { ascending: true }),
    { empty: [] },
  );

  return {
    ...events,
    data: events.data.map((e) => ({
      id: e.id,
      name: e.name,
      stroke: e.stroke,
      distanceM: e.distance_m,
      sessionNumber: numberById.get(e.session_id) ?? 0,
    })),
  };
}

/** Roster for one team, annotated with everything validateSquad needs. */
export async function fetchRelayCandidates(
  teamId: string,
  meetVolumeId: string,
  eventId: string,
): Promise<FetchResult<RelayCandidate[]>> {
  const supabase = createClient();

  const roster = await runQuery<RawRosterRow[]>(
    "Loading the team roster",
    async () => {
      const { data, error } = await supabase
        .from("athletes")
        .select("id, gender, age_group, users!athletes_user_id_fkey ( full_name )")
        .eq("team_id", teamId);
      return { data: data as unknown as RawRosterRow[] | null, error };
    },
    { empty: [] },
  );
  if (roster.data.length === 0) return { ...roster, data: [] };

  const athleteIds = roster.data.map((a) => a.id);

  // Who has an individual entry in this volume.
  const entered = await runQuery<{ athlete_id: string }[]>(
    "Checking meet entries",
    async () => {
      const { data, error } = await supabase
        .from("entries")
        .select("athlete_id, events!inner ( sessions!inner ( meet_volume_id ) )")
        .in("athlete_id", athleteIds)
        .eq("events.sessions.meet_volume_id", meetVolumeId);
      return { data: data as unknown as { athlete_id: string }[] | null, error };
    },
    { empty: [] },
  );
  const enteredIds = new Set(entered.data.map((e) => e.athlete_id));

  // Who is already in a squad for THIS event, on any team.
  const taken = await runQuery<RawTakenRow[]>(
    "Checking existing relay squads",
    async () => {
      const { data, error } = await supabase
        .from("relay_legs")
        .select("athlete_id, relay_squads!inner ( squad_letter, event_id )")
        .in("athlete_id", athleteIds)
        .eq("relay_squads.event_id", eventId);
      return { data: data as unknown as RawTakenRow[] | null, error };
    },
    { empty: [] },
  );
  const takenBy = new Map(
    taken.data.map((t) => {
      const squad = Array.isArray(t.relay_squads) ? t.relay_squads[0] : t.relay_squads;
      return [t.athlete_id, squad?.squad_letter ?? "?"] as const;
    }),
  );

  const firstName = (u: RelayCandidateUsers) => (Array.isArray(u) ? u[0] : u)?.full_name;

  return {
    data: roster.data
      .map((a) => ({
        athleteId: a.id,
        fullName: firstName(a.users) ?? "Unknown swimmer",
        gender: a.gender,
        ageGroup: a.age_group,
        enteredInMeet: enteredIds.has(a.id),
        takenBySquad: takenBy.get(a.id) ?? null,
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    error: roster.error ?? entered.error ?? taken.error,
    usedFallback: false,
  };
}

type RelayCandidateUsers = { full_name: string } | { full_name: string }[] | null;

interface RawTakenRow {
  athlete_id: string;
  relay_squads: { squad_letter: string; event_id: string } | { squad_letter: string; event_id: string }[] | null;
}

interface RawRosterRow {
  id: string;
  gender: Gender;
  age_group: AgeGroup;
  users: RelayCandidateUsers;
}

export async function fetchTeamSquads(
  teamId: string,
  meetVolumeId: string,
): Promise<FetchResult<RelaySquadView[]>> {
  const supabase = createClient();
  const result = await runQuery<RawSquad[]>(
    "Loading your relay squads",
    async () => {
      const { data, error } = await supabase
        .from("relay_squads")
        .select(
          "id, event_id, team_id, age_group, squad_letter, status, events!inner ( name, stroke, sessions!inner ( meet_volume_id ) ), relay_legs ( leg_number, athlete_id, athletes ( users!athletes_user_id_fkey ( full_name ) ) )",
        )
        .eq("team_id", teamId)
        .eq("events.sessions.meet_volume_id", meetVolumeId)
        .order("squad_letter", { ascending: true });
      return { data: data as unknown as RawSquad[] | null, error };
    },
    { empty: [] },
  );

  const one = <T,>(v: T | T[] | null | undefined): T | null =>
    Array.isArray(v) ? v[0] ?? null : v ?? null;

  return {
    ...result,
    data: result.data.map((s) => {
      const event = one(s.events);
      const stroke = event?.stroke ?? "";
      return {
        id: s.id,
        eventId: s.event_id,
        eventName: event?.name ?? "Relay",
        eventStroke: stroke,
        teamId: s.team_id,
        ageGroup: s.age_group,
        squadLetter: s.squad_letter,
        status: s.status,
        legs: (s.relay_legs ?? [])
          .map((l) => ({
            legNumber: l.leg_number,
            athleteId: l.athlete_id,
            athleteName: one(one(l.athletes)?.users)?.full_name ?? "Unknown swimmer",
            stroke: legStroke(stroke, l.leg_number),
          }))
          .sort((a, b) => a.legNumber - b.legNumber),
      };
    }),
  };
}

interface RawSquad {
  id: string;
  event_id: string;
  team_id: string;
  age_group: AgeGroup;
  squad_letter: string;
  status: EntryStatus;
  events:
    | { name: string; stroke: string }
    | { name: string; stroke: string }[]
    | null;
  relay_legs:
    | {
        leg_number: number;
        athlete_id: string;
        athletes:
          | { users: { full_name: string } | { full_name: string }[] | null }
          | { users: { full_name: string } | { full_name: string }[] | null }[]
          | null;
      }[]
    | null;
}

/**
 * Writes a squad and its four legs.
 *
 * The legs are inserted in one statement so the deferred constraint trigger
 * judges the finished squad, not a half-built one. If anything is rejected the
 * squad row is removed, because a squad with no legs is not a thing that
 * should exist.
 */
export async function createRelaySquad(input: {
  eventId: string;
  teamId: string;
  ageGroup: AgeGroup;
  squadLetter: string;
  athleteIdsByLeg: string[];
}): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();

  const { data: squad, error: squadError } = await supabase
    .from("relay_squads")
    .insert({
      event_id: input.eventId,
      team_id: input.teamId,
      age_group: input.ageGroup,
      squad_letter: input.squadLetter,
      created_by: auth.user?.id ?? null,
    })
    .select("id")
    .single();
  if (squadError || !squad) {
    return { success: false, error: squadError?.message ?? "Couldn't create the squad." };
  }

  const { error: legError } = await supabase.from("relay_legs").insert(
    input.athleteIdsByLeg.map((athleteId, index) => ({
      squad_id: squad.id,
      leg_number: index + 1,
      athlete_id: athleteId,
    })),
  );
  if (legError) {
    await supabase.from("relay_squads").delete().eq("id", squad.id);
    return { success: false, error: legError.message };
  }

  return { success: true };
}

export async function deleteRelaySquad(squadId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("relay_squads").delete().eq("id", squadId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
