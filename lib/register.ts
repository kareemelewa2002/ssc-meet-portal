import { createClient } from "@/lib/supabase/client";
import {
  SIGNUP_AGE_REJECTION_MESSAGE,
  ageGroupForAge,
  calculateAge,
  isEligibleForSignup,
  requiresParentLink,
} from "@/lib/age";
import type { AgeGroup, Gender, ParentLinkStatus } from "@/lib/supabase/types";

export type SignupRole = "athlete" | "coach" | "parent";

export interface AccountFormInput {
  role: SignupRole;
  email: string;
  fullName: string;
  phone: string;
  password: string;
}

export interface AthleteBioInput {
  dateOfBirth: string;
  gender: Gender;
  heightCm?: number | null;
  weightKg?: number | null;
  specialtyEvents: string[];
  profileImageUrl?: string | null;
  parentEmail?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateAthleteAge(dateOfBirth: string, today: Date = new Date()): ValidationResult {
  const age = calculateAge(dateOfBirth, today);
  if (!isEligibleForSignup(age)) {
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
  const age = calculateAge(dateOfBirth, today);
  if (requiresParentLink(age) && !parentEmail?.trim()) {
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
  const age = calculateAge(bio.dateOfBirth, today);
  const needsParent = requiresParentLink(age);
  return {
    date_of_birth: bio.dateOfBirth,
    age,
    age_group: ageGroupForAge(age),
    gender: bio.gender,
    height_cm: bio.heightCm ?? null,
    weight_kg: bio.weightKg ?? null,
    specialty_events: bio.specialtyEvents,
    parent_link_status: needsParent ? "pending" : "none",
    pending_parent_email: needsParent ? (bio.parentEmail?.trim() || null) : null,
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

/** Athletes may only submit meet entries once parent linkage is resolved —
 * i.e. not stuck in 'pending'. 15+ athletes (parent_link_status: 'none')
 * are always clear. */
export function canSubmitEntries(athlete: {
  parentLinkStatus: ParentLinkStatus;
}): ValidationResult {
  if (athlete.parentLinkStatus === "pending") {
    return {
      ok: false,
      error:
        "Parent/guardian authorization is required before this athlete can enter a meet volume.",
    };
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

  const supabase = createClient();
  const { data, error } = await supabase.auth.signUp({
    email: account.email,
    password: account.password,
    options: {
      data: { full_name: account.fullName, role: account.role, phone: account.phone },
    },
  });
  if (error || !data.user) {
    return { success: false, error: error?.message ?? "Sign up failed." };
  }

  if (account.role === "athlete" && athleteBio) {
    const payload = buildAthleteProfileInsert(athleteBio);
    let parentId: string | null = null;
    let parentLinkStatus = payload.parent_link_status;

    if (payload.pending_parent_email) {
      const { data: parentUser } = await supabase
        .from("users")
        .select("id")
        .eq("email", payload.pending_parent_email)
        .maybeSingle();
      if (parentUser) {
        parentId = parentUser.id;
        parentLinkStatus = "verified";
      }
    }

    const { error: athleteError } = await supabase.from("athletes").insert({
      user_id: data.user.id,
      parent_id: parentId,
      ...payload,
      parent_link_status: parentLinkStatus,
    });
    if (athleteError) return { success: false, error: athleteError.message };

    if (athleteBio.profileImageUrl) {
      await supabase
        .from("users")
        .update({ profile_image_url: athleteBio.profileImageUrl })
        .eq("id", data.user.id);
    }
  }

  if (account.role === "parent") {
    // Link to any athlete who named this email while it had no account yet.
    await supabase.rpc("claim_pending_parent_links");
  }

  return { success: true, userId: data.user.id };
}
