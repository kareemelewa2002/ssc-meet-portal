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
 */
export function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message
  }
  return fallback
}
