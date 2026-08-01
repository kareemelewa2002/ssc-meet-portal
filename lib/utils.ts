import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Extracts a display message from a caught error. Supabase/Postgrest errors
 * thrown via `throw fetchError` are plain `{message, code, ...}` objects,
 * NOT `Error` instances — `err instanceof Error` is always false for them,
 * so checking only that case silently swallows the real reason and always
 * shows `fallback` instead. This checks both shapes before giving up.
 *
 * Also rejects unusable message strings (`"{}"`, `"[object Object]"`, blank)
 * that supabase-js has been observed to attach as AuthError.message after
 * internal serialization of an empty/opaque failure payload.
 */
export function getErrorMessage(err: unknown, fallback: string): string {
  let message: string | undefined
  if (err instanceof Error) message = err.message
  else if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    message = err.message
  }

  if (!message) return fallback
  const trimmed = message.trim()
  if (!trimmed || trimmed === "{}" || trimmed === "[object Object]") return fallback
  return trimmed
}

/**
 * User-facing copy for sign-in failures. Maps opaque network / config
 * failures and unusable AuthError.message values to actionable guidance.
 */
export function formatSignInError(err: unknown): string {
  const fallback = "Sign-in failed. Check your email and password."
  const raw = getErrorMessage(err, "")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""

  if (!url || url.includes("your-project.supabase.co")) {
    return (
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local, then restart the dev server."
    )
  }
  if (/failed to fetch|networkerror|load failed|err_name_not_resolved/i.test(raw)) {
    return (
      "Could not reach Supabase. Check NEXT_PUBLIC_SUPABASE_URL in .env.local " +
      "and your network connection, then restart the dev server."
    )
  }
  if (/invalid api key/i.test(raw)) {
    return (
      "Invalid Supabase anon key. Update NEXT_PUBLIC_SUPABASE_ANON_KEY in " +
      ".env.local and restart the dev server."
    )
  }
  if (/invalid login credentials|invalid_credentials/i.test(raw)) {
    return (
      "Invalid email or password. If this is the real admin email that existed " +
      "before seeding, use that account’s own password — not the demo Password123!."
    )
  }
  return raw || fallback
}
