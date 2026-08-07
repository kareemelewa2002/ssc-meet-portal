import { createClient } from "@/lib/supabase/client";
import {
  MIN_SIGNUP_AGE,
  SIGNUP_AGE_REJECTION_MESSAGE,
  ageGroupForBirthYear,
  ageTurningThisYear,
  isEligibleForSignup,
  requiresParentLink,
} from "@/lib/age";
import type { AgeGroup, Gender, ParentLinkStatus } from "@/lib/supabase/types";

export type SignupRole = "athlete" | "parent";

export interface AccountFormInput {
  role: SignupRole;
  email: string;
  fullName: string;
  phone: string;
  password: string;
}

export interface AthleteBioInput {
  dateOfBirth: string;
  /** Safety & privacy acknowledgement ticked at signup. Only honoured for
   * 15+; a U14's acceptance must come from their parent's own account (see
   * public.accept_safety_acknowledgement). */
  safetyAccepted?: boolean;
  gender: Gender;
  heightCm?: number | null;
  weightKg?: number | null;
  specialtyEvents: string[];
  profileImageUrl?: string | null;
  parentEmail?: string | null;
  /** From a captain's shareable invite link (?invite=<token>). Resolved and
   * consumed inside public.handle_new_auth_user() at signup time — see the
   * SQL function's own comment for why this can't be a separate client-side
   * step (no active session exists between signUp() and that trigger
   * running, since email confirmation is required). */
  teamInviteToken?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateAthleteAge(dateOfBirth: string, today: Date = new Date()): ValidationResult {
  if (!isEligibleForSignup(dateOfBirth, today)) {
    return { ok: false, error: SIGNUP_AGE_REJECTION_MESSAGE };
  }
  return { ok: true };
}

export const PARENT_EMAIL_REQUIRED_MESSAGE =
  "Swimmers under 15 must provide a parent or guardian email before signing up.";

export function validateParentLinkage(
  dateOfBirth: string,
  parentEmail: string | null | undefined,
  today: Date = new Date(),
): ValidationResult {
  if (requiresParentLink(dateOfBirth, today) && !parentEmail?.trim()) {
    return { ok: false, error: PARENT_EMAIL_REQUIRED_MESSAGE };
  }
  return { ok: true };
}

export interface AthleteProfileInsertPayload {
  date_of_birth: string;
  age: number;
  age_group: AgeGroup;
  gender: Gender;
  height_cm: number | null;
  weight_kg: number | null;
  specialty_events: string[];
  parent_link_status: ParentLinkStatus;
  pending_parent_email: string | null;
}

/**
 * Pure builder for the athletes-table insert payload — kept entirely
 * separate from Supabase I/O (testable in isolation) and, just as
 * importantly, separate from lib/event-registration.ts's entry builder:
 * account creation never touches events/entries, and meet registration
 * never touches auth/profile fields. See lib/__tests__/register.test.ts for
 * the assertion that the two payload shapes share no keys.
 */
export function buildAthleteProfileInsert(
  bio: AthleteBioInput,
  today: Date = new Date(),
): AthleteProfileInsertPayload {
  // Stored `age` mirrors the SQL trigger (public.handle_new_auth_user): the
  // age the swimmer turns this year, not their exact calendar age — same
  // value age_group and the parent-link gate are derived from, and clamped
  // to the athletes.age table's `>= 13` check constraint.
  const age = Math.max(ageTurningThisYear(bio.dateOfBirth, today), MIN_SIGNUP_AGE);
  const needsParent = requiresParentLink(bio.dateOfBirth, today);
  return {
    date_of_birth: bio.dateOfBirth,
    age,
    age_group: ageGroupForBirthYear(bio.dateOfBirth, today),
    gender: bio.gender,
    height_cm: bio.heightCm ?? null,
    weight_kg: bio.weightKg ?? null,
    specialty_events: bio.specialtyEvents,
    parent_link_status: needsParent ? "pending" : "none",
    pending_parent_email: needsParent ? (bio.parentEmail?.trim() || null) : null,
    // approved_by_admin is deliberately absent: account approval no longer
    // exists, and the column now defaults to true at the database. Setting it
    // here would re-create, one layer up, the exact bug that the dropped
    // enforce_athlete_approval_change() trigger caused — new signups silently
    // landing unapproved.
  };
}

/** Shareable link a swimmer under 15 can send their parent/guardian so the
 * parent's own signup (via public.claim_pending_parent_links()) links back. */
export function buildParentInviteLink(pendingParentEmail: string, origin: string): string {
  const url = new URL("/register", origin);
  url.searchParams.set("role", "parent");
  url.searchParams.set("invited_email", pendingParentEmail);
  return url.toString();
}

export const SAFETY_NOT_ACCEPTED_MESSAGE =
  "The safety & privacy acknowledgement must be accepted before entering a meet. For swimmers under 15 this must be done by their parent, from the parent's own account.";

/**
 * Gates meet entry.
 *
 * Account approval is gone entirely: paying the entry fee is the seriousness
 * signal, and the admin confirming that payment is what seeds the heats. What
 * still blocks a swimmer is only what would be unlawful or unsafe to swim
 * without — parent linkage for a U14, and the safety acknowledgement.
 */
export function canSubmitEntries(athlete: {
  parentLinkStatus: ParentLinkStatus;
  safetyAcceptedAt?: string | null;
}): ValidationResult {
  if (athlete.parentLinkStatus === "pending") {
    return {
      ok: false,
      error:
        "Parent/guardian authorization is required before this athlete can enter a meet volume.",
    };
  }
  if (athlete.safetyAcceptedAt === null) {
    return { ok: false, error: SAFETY_NOT_ACCEPTED_MESSAGE };
  }
  return { ok: true };
}

export interface RegisterAccountResult {
  success: boolean;
  userId?: string;
  error?: string;
}

/** Orchestrates Supabase Auth signUp, then (for athletes) the profile
 * insert + parent-linkage resolution. */
export async function registerAccount(
  account: AccountFormInput,
  athleteBio?: AthleteBioInput,
): Promise<RegisterAccountResult> {
  if (account.role === "athlete") {
    if (!athleteBio) return { success: false, error: "Missing athlete profile details." };
    const ageCheck = validateAthleteAge(athleteBio.dateOfBirth);
    if (!ageCheck.ok) return { success: false, error: ageCheck.error };
    const parentCheck = validateParentLinkage(athleteBio.dateOfBirth, athleteBio.parentEmail);
    if (!parentCheck.ok) return { success: false, error: parentCheck.error };
  }

  // This project requires email confirmation (mailer_autoconfirm = false),
  // so signUp() never returns an active session for a brand-new user —
  // auth.uid() is null for anything the client sends right after this
  // resolves, until the confirmation email is clicked. A client-side
  // `.from("athletes").insert(...)` here would ALWAYS fail RLS, not just
  // occasionally. So the full athlete bio (and the profile photo URL) rides
  // in signUp()'s options.data instead, and public.handle_new_auth_user()
  // — a SECURITY DEFINER trigger that already creates the public.users row
  // this same way — creates public.athletes from that metadata too. See the
  // trigger's comment in supabase/schema.sql for the full explanation.
  const supabase = createClient();
  const { data, error } = await supabase.auth.signUp({
    email: account.email,
    password: account.password,
    options: {
      data: {
        full_name: account.fullName,
        role: account.role,
        phone: account.phone,
        ...(account.role === "athlete" && athleteBio
          ? {
              date_of_birth: athleteBio.dateOfBirth,
              gender: athleteBio.gender,
              height_cm: athleteBio.heightCm ?? null,
              weight_kg: athleteBio.weightKg ?? null,
              specialty_events: athleteBio.specialtyEvents,
              parent_email: athleteBio.parentEmail?.trim() || null,
              profile_image_url: athleteBio.profileImageUrl || null,
              safety_accepted: athleteBio.safetyAccepted === true,
              team_invite_token: athleteBio.teamInviteToken?.trim() || null,
            }
          : {}),
      },
    },
  });
  if (error || !data.user) {
    return { success: false, error: error?.message ?? "Sign up failed." };
  }

  if (account.role === "parent") {
    // Link to any athlete who named this email while it had no account yet.
    // Best-effort: this also requires an active session (same confirmation
    // gate as above) — claim_pending_parent_links() runs again on next
    // sign-in for any parent whose confirmation was still pending here.
    await supabase.rpc("claim_pending_parent_links");
  }

  return { success: true, userId: data.user.id };
}
