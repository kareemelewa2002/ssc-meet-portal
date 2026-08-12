import type { AgeGroup } from "@/lib/supabase/types";

/** SSC platform accounts require swimmers to be at least this old. */
export const MIN_SIGNUP_AGE = 13;

/** Athletes 13-14 (i.e. under 15) must have a parent/guardian linked before
 * they can submit entries for any meet volume. */
export const PARENT_LINK_MAX_AGE = 14;

export const SIGNUP_AGE_REJECTION_MESSAGE =
  "SSC platform accounts require swimmers to be at least 13 years old.";

/**
 * Whole years between a date of birth and a reference date (defaults to
 * today). Mirrors supabase/schema.sql's public.age_at_date() exactly —
 * calendar-aware (accounts for whether the birthday has occurred yet in the
 * reference year), not a naive year subtraction.
 *
 * DISPLAY ONLY (profile page, historical "age at swim" ledgers). Never use
 * this for age-group bucketing, signup eligibility, or the parent-link gate
 * — those use ageTurningThisYear below, the swim-federation convention.
 */
export function calculateAge(dateOfBirth: string | Date, onDate: string | Date = new Date()): number {
  const dob = new Date(dateOfBirth);
  const on = new Date(onDate);

  let years = on.getFullYear() - dob.getFullYear();
  const monthDiff = on.getMonth() - dob.getMonth();
  const dayDiff = on.getDate() - dob.getDate();

  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    years -= 1;
  }

  return years;
}

/**
 * The age a swimmer turns during `referenceDate`'s calendar year — the
 * standard swim-federation convention for age-group brackets, signup
 * eligibility, and the parent-link gate, so a swimmer's bracket never flips
 * mid-season around their birthday. Mirrors
 * supabase/schema.sql's public.age_turning_this_year().
 */
export function ageTurningThisYear(dateOfBirth: string | Date, referenceDate: string | Date = new Date()): number {
  const dob = new Date(dateOfBirth);
  const ref = new Date(referenceDate);
  return ref.getFullYear() - dob.getFullYear();
}

/** Buckets a turning-age (see ageTurningThisYear) into U14 (13-14), U17 (15-17), Open (18+). */
export function ageGroupForAge(age: number): AgeGroup {
  if (age <= 14) return "U14";
  if (age <= 17) return "U17";
  return "Open";
}

/** U14: turns 13-14 this year (e.g. born 2012/2013 for the 2026 season).
 * U17: turns 15-17 (born 2009/2010/2011). Open: turns 18+ (born 2008 or earlier). */
export function ageGroupForBirthYear(
  dateOfBirth: string | Date,
  referenceDate: string | Date = new Date(),
): AgeGroup {
  return ageGroupForAge(ageTurningThisYear(dateOfBirth, referenceDate));
}

export function isEligibleForSignup(dateOfBirth: string | Date, referenceDate: string | Date = new Date()): boolean {
  return ageTurningThisYear(dateOfBirth, referenceDate) >= MIN_SIGNUP_AGE;
}

/** Under 15 (turns 13-14 this year) — needs a parent/guardian linked before entering a meet. */
export function requiresParentLink(dateOfBirth: string | Date, referenceDate: string | Date = new Date()): boolean {
  return ageTurningThisYear(dateOfBirth, referenceDate) <= PARENT_LINK_MAX_AGE;
}

/**
 * "Swum at age 14 in SSC Vol. 1" — for leaderboard rows, All-Time records,
 * career ledgers, and profile race cards. Always pass the age computed at
 * the meet's date (e.g. via calculateAge(dob, meetDate)), never the
 * swimmer's current age.
 */
export function describeAgeAtSwim(ageAtSwim: number, volumeName: string): string {
  return `Swum at age ${ageAtSwim} in ${volumeName}`;
}

/**
 * Which age groups may swim in a squad or board of `boardAgeGroup`.
 *
 * Boards in this app are CUMULATIVE — "this age and younger", with Open
 * meaning open to everyone. public.event_results has always ranked results
 * that way (a 14 & Under swimmer appears in the 14 & Under, 17 & Under and
 * Open standings), but relay squads used to demand an exact match, so a U14
 * swimmer could be ranked on the Open board yet not be allowed to swim an
 * Open relay. The word "Open" meant two different things depending on which
 * screen you were on.
 *
 * Mirrors public.relay_age_eligible() in supabase/schema.sql. Keep the two in
 * step: the SQL copy is the enforcement, this one drives the picker so a
 * captain is never offered a swimmer the database will reject.
 */
export function eligibleAgeGroupsFor(boardAgeGroup: AgeGroup): AgeGroup[] {
  switch (boardAgeGroup) {
    case "Open":
      return ["U14", "U17", "Open"];
    case "U17":
      return ["U14", "U17"];
    case "U14":
    default:
      return ["U14"];
  }
}

/** Whether `athleteAgeGroup` may compete in a `boardAgeGroup` squad or board. */
export function isAgeEligibleFor(boardAgeGroup: AgeGroup, athleteAgeGroup: AgeGroup): boolean {
  return eligibleAgeGroupsFor(boardAgeGroup).includes(athleteAgeGroup);
}
