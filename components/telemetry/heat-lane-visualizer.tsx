"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { LaneCard } from "@/components/telemetry/lane-card";
import { fetchPersonalBestsForEventShape } from "@/lib/telemetry";
import type { LiveHeatView, LiveLaneView } from "@/lib/live-heats";

/**
 * The pool: one heat's full lane configuration, occupied lanes and empty
 * ones both, laid out top-to-bottom in ascending lane order (1..laneCount).
 * Lane NUMBER, not swimmer speed, drives position — the existing seeding
 * pipeline is what already put the fastest seeds in the centre lanes
 * (lib/skins-lanes.ts's centredLanes()); this component only renders
 * whatever lane each swimmer was already assigned to.
 *
 * Empty lanes render as dim ghost slots rather than being omitted, so the
 * pool's actual configured width (laneCount, an admin-set value per volume —
 * meet_settings.lane_count) is always visible even in a sparsely-filled
 * heat.
 */
export function HeatLaneVisualizer({
  heat,
  laneCount,
  stroke,
  distanceM,
  onSelectLane,
}: {
  heat: LiveHeatView;
  laneCount: number;
  stroke: string;
  distanceM: number;
  /** Opens the swimmer deep-dive modal for an occupied lane. */
  onSelectLane?: (lane: LiveLaneView) => void;
}) {
  const [personalBests, setPersonalBests] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const athleteIds = heat.lanes.map((l) => l.athleteId);
    (async () => {
      const bests = await fetchPersonalBestsForEventShape(athleteIds, stroke, distanceM);
      if (!cancelled) setPersonalBests(bests);
    })();
    return () => {
      cancelled = true;
    };
    // heat.heatId is the real dependency; heat.lanes is a new array identity
    // on every parent render otherwise, which would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heat.heatId, stroke, distanceM]);

  const byLane = new Map(heat.lanes.map((l) => [l.laneNumber, l]));
  const slots = Array.from({ length: laneCount }, (_, i) => i + 1);

  return (
    <div
      className="glass-hud relative overflow-hidden rounded-2xl p-3"
      style={{
        background:
          "repeating-linear-gradient(180deg, color-mix(in oklch, var(--color-neon-cyan) 4%, transparent) 0 2px, transparent 2px 100%), color-mix(in oklch, var(--card) 80%, transparent)",
      }}
      data-glass
    >
      <div role="list" aria-label={`Heat ${heat.heatNumber} lane assignments`} className="flex flex-col gap-2">
        <AnimatePresence mode="popLayout">
          {slots.map((laneNumber, index) => {
            const lane = byLane.get(laneNumber);
            if (!lane) {
              return (
                <motion.div
                  key={`empty-${laneNumber}`}
                  role="listitem"
                  aria-label={`Lane ${laneNumber}: no swimmer assigned`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2, delay: index * 0.02 }}
                  className="flex min-h-[64px] items-center gap-3 rounded-xl border border-dashed px-3 py-2 opacity-40"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg font-telemetry text-base font-bold text-[var(--muted-foreground)]">
                    {laneNumber}
                  </div>
                  <p className="text-sm text-[var(--muted-foreground)]">Empty</p>
                </motion.div>
              );
            }
            return (
              <LaneCard
                key={lane.athleteId}
                lane={lane}
                personalBestMs={personalBests.get(lane.athleteId)}
                index={index}
                onSelect={onSelectLane ? () => onSelectLane(lane) : undefined}
              />
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
