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
  approved_by_admin: boolean;
}

export const SWIMMER_PENDING_APPROVAL_MESSAGE =
  "Swimmer registration pending admin approval.";

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
    approved_by_admin: false,
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

/** Athletes may only submit meet entries once parent linkage is resolved
 * and an admin has approved their registration. */
export function canSubmitEntries(athlete: {
  parentLinkStatus: ParentLinkStatus;
  approvedByAdmin?: boolean;
}): ValidationResult {
  if (athlete.approvedByAdmin === false) {
    return { ok: false, error: SWIMMER_PENDING_APPROVAL_MESSAGE };
  }
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
