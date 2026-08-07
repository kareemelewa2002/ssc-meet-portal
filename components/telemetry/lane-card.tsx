"use client";

import { motion, useReducedMotion } from "motion/react";
import { formatTimeMs } from "@/lib/format";
import type { LiveLaneView } from "@/lib/live-heats";

/**
 * One lane in the Heat & Lane Visualizer. A leaf client component: it owns
 * no data fetching and no cross-lane state, only its own entrance/press
 * motion — the spring physics this whole component exists for.
 *
 * Animates ONLY `transform` and `opacity` (translate/scale, never
 * width/height/margin), so this stays on the compositor thread regardless of
 * how many lanes are on screen at once.
 */
export function LaneCard({
  lane,
  personalBestMs,
  index,
  onSelect,
}: {
  lane: LiveLaneView;
  /** From fetchPersonalBestsForEventShape — absent (not null) when the
   * swimmer has no qualifying published swim in this exact stroke/distance
   * yet, which reads differently from "0" or "—" meaning DNS/DQ. */
  personalBestMs: number | undefined;
  /** Position in the current lane list, purely for the staggered entrance —
   * NOT the lane number, which is `lane.laneNumber` and can start anywhere
   * once empty outer lanes are skipped. */
  index: number;
  /** Opens the swimmer deep-dive modal. Optional: the card stays a plain,
   * non-interactive readout wherever no handler is wired, rather than
   * advertising a click that goes nowhere. */
  onSelect?: () => void;
}) {
  const reduceMotion = useReducedMotion();

  const seedMs = lane.seedTimeMs;
  const officialMs = lane.result?.status === "published" ? lane.result.officialTimeMs : null;
  const varianceMs = officialMs != null && seedMs != null ? officialMs - seedMs : null;

  return (
    <motion.div
      role="listitem"
      aria-label={`Lane ${lane.laneNumber}: ${lane.athleteName}, ${lane.teamName ?? "unattached"}, seed time ${formatTimeMs(seedMs)}`}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -16, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={
        reduceMotion
          ? { duration: 0.15 }
          : { type: "spring", stiffness: 300, damping: 28, delay: index * 0.04 }
      }
      whileHover={reduceMotion || !onSelect ? undefined : { scale: 1.015, transition: { type: "spring", stiffness: 400, damping: 25 } }}
      whileTap={reduceMotion || !onSelect ? undefined : { scale: 0.98 }}
      className="glass-hud group min-h-[64px] rounded-xl text-[var(--foreground)]"
    >
      {/* The interactive element is the inner button, not the listitem
          wrapper: a role="listitem" that is also a button is not a shape any
          screen reader can announce honestly. */}
      <Row as={onSelect ? "button" : "div"} onSelect={onSelect}>
      <div
        className="flex size-9 shrink-0 items-center justify-center rounded-lg font-telemetry text-base font-bold"
        style={{
          background: "color-mix(in oklch, var(--color-neon-cyan) 22%, transparent)",
          color: "var(--color-neon-cyan)",
          boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--color-neon-cyan) 45%, transparent)",
        }}
      >
        {lane.laneNumber}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{lane.athleteName}</p>
        <p className="truncate text-xs text-[var(--muted-foreground)]">
          {lane.teamName ?? "Unattached"}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        <span className="font-telemetry text-sm text-[var(--muted-foreground)]">
          Seed {lane.isNt ? "NT" : formatTimeMs(seedMs)}
        </span>
        {personalBestMs != null && (
          <span
            className="font-telemetry text-xs"
            style={{ color: "var(--color-neon-lime)" }}
          >
            PB {formatTimeMs(personalBestMs)}
          </span>
        )}
        {officialMs != null && (
          <span
            className="font-telemetry text-xs font-bold"
            style={{
              color:
                varianceMs != null && varianceMs < 0
                  ? "var(--color-neon-lime)"
                  : "var(--color-neon-orange)",
            }}
          >
            {formatTimeMs(officialMs)}
          </span>
        )}
      </div>
      </Row>
    </motion.div>
  );
}

/** The card's inner flex row — a real `<button>` when the card opens the
 * swimmer modal, an inert `<div>` when it does not. */
function Row({
  as,
  onSelect,
  children,
}: {
  as: "button" | "div";
  onSelect?: () => void;
  children: React.ReactNode;
}) {
  const className =
    "flex w-full min-h-[64px] items-center gap-3 rounded-xl px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2";
  if (as === "div") return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={className}
      style={{ outlineColor: "var(--color-neon-cyan)" }}
    >
      {children}
    </button>
  );
}
