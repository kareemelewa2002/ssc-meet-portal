"use client";

import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { StandingCard } from "@/components/telemetry/standing-card";
import type { TelemetryStanding } from "@/lib/telemetry";

/**
 * The event leaderboard: every swimmer across every heat of the selected
 * event, fastest first. One card is expanded at a time — an accordion rather
 * than independent toggles, so the list cannot grow past the point where the
 * standings stop being scannable on a phone at the pool deck.
 *
 * `aria-live="polite"` because places and times here change underneath the
 * viewer as results are published: a screen-reader user watching the board
 * should hear the standing update, not have to re-navigate to find it.
 */
export function TelemetryLeaderboard({
  standings,
  onOpenProfile,
}: {
  standings: TelemetryStanding[];
  onOpenProfile: (standing: TelemetryStanding) => void;
}) {
  // Keyed by athlete + lane, not athlete alone: the same swimmer can legally
  // appear twice in one event's standings (a swim-off re-swim).
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  if (standings.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)]">No swimmers in this event yet.</p>
    );
  }

  return (
    <ul
      aria-label="Event standings"
      aria-live="polite"
      className="flex list-none flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {standings.map((standing, index) => {
          const key = `${standing.athleteId}-${standing.heatNumber}-${standing.laneNumber}`;
          return (
            <StandingCard
              key={key}
              standing={standing}
              index={index}
              expanded={expandedKey === key}
              onToggle={() => setExpandedKey((prev) => (prev === key ? null : key))}
              onOpenProfile={() => onOpenProfile(standing)}
            />
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
