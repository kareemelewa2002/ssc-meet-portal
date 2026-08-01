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

/** U13-14 (13-14), U17 (15-17), Open (18+). */
export function ageGroupForAge(age: number): AgeGroup {
  if (age <= 14) return "U13_14";
  if (age <= 17) return "U17";
  return "Open";
}

export function isEligibleForSignup(age: number): boolean {
  return age >= MIN_SIGNUP_AGE;
}

/** Under 15 (ages 13-14) — needs a parent/guardian linked before entering a meet. */
export function requiresParentLink(age: number): boolean {
  return age <= PARENT_LINK_MAX_AGE;
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
