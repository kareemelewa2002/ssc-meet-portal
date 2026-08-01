/** Formats milliseconds as swim-meet clock time, e.g. 65432 -> "1:05.43". */
export function formatTimeMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const totalCentiseconds = Math.round(ms / 10);
  const minutes = Math.floor(totalCentiseconds / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  const secondsStr = seconds.toString().padStart(2, "0");
  const centisecondsStr = centiseconds.toString().padStart(2, "0");
  return minutes > 0
    ? `${minutes}:${secondsStr}.${centisecondsStr}`
    : `${seconds}.${centisecondsStr}`;
}

/**
 * Parses a swim-meet clock time entered as "mm:ss.cc", "ss.cc", or a plain
 * millisecond integer into milliseconds. Returns null for empty/invalid input.
 */
export function parseTimeToMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
  return Math.round((minutes * 60 + seconds) * 1000);
}

/** Positive time drop in seconds (seed -> official), or null if not an improvement. */
export function timeDropSeconds(
  seedTimeMs: number | null | undefined,
  officialTimeMs: number | null | undefined,
): number | null {
  if (seedTimeMs == null || officialTimeMs == null) return null;
  if (officialTimeMs >= seedTimeMs) return null;
  return Math.round((seedTimeMs - officialTimeMs) / 10) / 100;
}
