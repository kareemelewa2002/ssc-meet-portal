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

const TEAM_LOGO_BUCKET = "team-logos";
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB

export interface UploadTeamLogoResult {
  url: string | null;
  error?: string;
}

/**
 * Uploads a team logo PNG to the public `team-logos` bucket.
 *
 * PNG ONLY, and checked on the MIME type rather than the file extension: a
 * renamed .png is still whatever it actually is, and the extension is the one
 * thing a user can change trivially. PNG specifically because a crest needs
 * transparency — a JPEG logo arrives with a white box baked around it, which
 * looks broken everywhere the logo sits on a coloured surface.
 *
 * Keyed by team id and stamped with the upload time, so a captain replacing a
 * logo does not have to wait for a CDN cache to expire before seeing it —
 * `upsert` on a fixed key would keep serving the old image from cache.
 */
export async function uploadTeamLogo(
  teamId: string,
  file: File,
): Promise<UploadTeamLogoResult> {
  if (file.type !== "image/png") {
    return { url: null, error: "Team logos must be a PNG file." };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return { url: null, error: "Logo must be smaller than 2MB." };
  }

  const supabase = createClient();
  const path = `${teamId}/${Date.now()}.png`;

  const { error } = await supabase.storage.from(TEAM_LOGO_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: "image/png",
  });
  if (error) return { url: null, error: error.message };

  const { data } = supabase.storage.from(TEAM_LOGO_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl };
}
