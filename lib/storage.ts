import { createClient } from "@/lib/supabase/client";

const AVATAR_BUCKET = "avatars";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB

export interface UploadAvatarResult {
  url: string | null;
  error?: string;
}

/**
 * Uploads a profile photo to the public `avatars` Supabase Storage bucket
 * and returns its public URL. Called at file-select time during
 * registration — before the account exists — so the object key is a random
 * id rather than the (not-yet-created) user's id; see the
 * avatars_anyone_upload RLS policy in supabase/schema.sql for why uploads
 * are scoped to the bucket rather than to auth.uid().
 */
export async function uploadAvatar(file: File): Promise<UploadAvatarResult> {
  if (!file.type.startsWith("image/")) {
    return { url: null, error: "Please choose an image file." };
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return { url: null, error: "Image must be smaller than 5MB." };
  }

  const supabase = createClient();
  const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `pending/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type,
  });
  if (error) return { url: null, error: error.message };

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl };
}
