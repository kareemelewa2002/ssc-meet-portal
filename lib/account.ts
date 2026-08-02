import { createClient } from "@/lib/supabase/client";

export interface UpdateProfileInput {
  fullName: string;
  phone: string | null;
  profileImageUrl: string | null;
}

export interface AccountActionResult {
  success: boolean;
  error?: string;
}

/** Updates the signed-in user's own public.users row (RLS:
 * users_update_own_profile). Role can never change through this path — a
 * separate trigger (enforce_role_change) blocks that for every caller but
 * an admin, regardless of which client code path attempts it. */
export async function updateMyProfile(input: UpdateProfileInput): Promise<AccountActionResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not signed in." };

  const { error } = await supabase
    .from("users")
    .update({
      full_name: input.fullName.trim(),
      phone: input.phone?.trim() || null,
      profile_image_url: input.profileImageUrl,
    })
    .eq("id", user.id);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function updateMyPassword(newPassword: string): Promise<AccountActionResult> {
  const supabase = createClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { success: false, error: error.message };
  return { success: true };
}
