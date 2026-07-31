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

/** Positive time drop in seconds (seed -> official), or null if not an improvement. */
export function timeDropSeconds(
  seedTimeMs: number | null | undefined,
  officialTimeMs: number | null | undefined,
): number | null {
  if (seedTimeMs == null || officialTimeMs == null) return null;
  if (officialTimeMs >= seedTimeMs) return null;
  return Math.round((seedTimeMs - officialTimeMs) / 10) / 100;
}
