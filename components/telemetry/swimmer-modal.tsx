"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { X, TrendingDown, Trophy } from "lucide-react";
import { formatTimeMs } from "@/lib/format";
import { formatWaPoints } from "@/lib/wa-points";
import { AGE_GROUP_LABELS, fetchAthleteProfile, type AthleteProfileView } from "@/lib/athletes";
import { buildPbTrajectory, type PbTrajectoryPoint } from "@/lib/telemetry";
import { TelemetryThemeScope } from "@/components/telemetry/telemetry-theme-scope";
import type { AgeGroup } from "@/lib/supabase/types";

/** Everything the modal needs about the ENTRY that was clicked. Deliberately
 * flat rather than "a lane" or "a standing", so both the pool visualizer and
 * the leaderboard can open the same modal from their own row shapes. */
export interface SwimmerModalTarget {
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  ageGroup: AgeGroup;
  eventName: string;
  stroke: string;
  distanceM: number;
  heatNumber: number;
  laneNumber: number;
  seedTimeMs: number | null;
  isNt: boolean;
  officialTimeMs: number | null;
  waPoints: number | null;
}

/**
 * The deep-dive: a spring-assisted glass slide-over over the telemetry board.
 * Slides in from the right on a desktop and up from the bottom on a phone —
 * both are pure `transform`, so neither reflows the page behind it.
 *
 * Data is real: entry metadata comes from the row that was clicked, and the
 * history below it from fetchAthleteProfile — the same query the athlete
 * profile page itself uses. Nothing here is placeholder.
 */
export function SwimmerModal({
  target,
  onClose,
}: {
  target: SwimmerModalTarget;
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [profile, setProfile] = useState<AthleteProfileView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const result = await fetchAthleteProfile(target.athleteId);
      if (cancelled) return;
      setProfile(result.data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [target.athleteId]);

  // Return focus to whatever opened the modal, so keyboard users land back on
  // the lane or standing row they were on rather than at the top of the page.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // Minimal focus trap: Tab must not escape into the board behind the
      // overlay, which is inert to the eye but not to the keyboard.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  const trajectory = profile
    ? buildPbTrajectory(profile.careerResults, target.stroke, target.distanceM)
    : [];
  const overallPb = profile?.personalBests.find(
    (pb) => pb.stroke === target.stroke && pb.distanceM === target.distanceM,
  );

  // Portalled to <body> so the overlay cannot be trapped inside a stacking
  // context created further up the telemetry page, and so it sits above the
  // fixed bottom tab nav (z-40) on a phone rather than under its edge. The
  // theme scope has to come WITH it: outside the telemetry subtree the
  // .telemetry-dark custom properties do not exist, and the modal would
  // render in the app's light palette. `display: contents` keeps the extra
  // wrapper out of the body's layout while still inheriting the tokens.
  return createPortal(
    <TelemetryThemeScope className="contents">
    <motion.div
      className="fixed inset-0 z-[60] flex items-end justify-end sm:items-stretch"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onKeyDown={onKeyDown}
    >
      <motion.div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: "oklch(0.08 0.02 255 / 0.7)", backdropFilter: "blur(4px)" }}
      />

      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${target.athleteName} — ${target.eventName}`}
        data-glass
        initial={
          reduceMotion ? { opacity: 0 } : { opacity: 0, x: "100%", y: 0 }
        }
        animate={{ opacity: 1, x: 0, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: "100%" }}
        transition={
          reduceMotion ? { duration: 0.15 } : { type: "spring", stiffness: 300, damping: 32 }
        }
        className="glass-hud relative flex max-h-[88vh] w-full flex-col overflow-y-auto rounded-t-2xl border-l p-4 sm:max-h-none sm:w-[26rem] sm:rounded-t-none sm:rounded-l-2xl"
        style={{ borderColor: "var(--border)", background: "var(--card)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-extrabold tracking-tight">{target.athleteName}</h2>
            <p className="truncate text-xs text-[var(--muted-foreground)]">
              {target.teamName ?? "Unattached"} · {AGE_GROUP_LABELS[target.ageGroup]}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close swimmer details"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
              background: "color-mix(in oklch, var(--foreground) 8%, transparent)",
              outlineColor: "var(--color-neon-cyan)",
            }}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <section className="mt-4" aria-label="This entry">
          <h3 className="text-[10px] font-semibold tracking-widest text-[var(--muted-foreground)] uppercase">
            {target.eventName}
          </h3>
          <div className="mt-2 grid grid-cols-4 gap-2">
            <Stat label="Heat" value={String(target.heatNumber)} />
            <Stat label="Lane" value={String(target.laneNumber)} />
            <Stat label="Seed" value={target.isNt ? "NT" : formatTimeMs(target.seedTimeMs)} />
            <Stat
              label="Swum"
              value={formatTimeMs(target.officialTimeMs)}
              accent={target.officialTimeMs != null ? "var(--color-neon-cyan)" : undefined}
            />
          </div>
          {target.waPoints != null && (
            <p className="mt-2 font-telemetry text-xs text-[var(--muted-foreground)]">
              {formatWaPoints(target.waPoints)} World Aquatics points
            </p>
          )}
        </section>

        <section className="mt-5" aria-label="Progression in this event">
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-widest text-[var(--muted-foreground)] uppercase">
            <TrendingDown className="size-3.5" aria-hidden />
            {target.distanceM}m {target.stroke} progression
          </h3>
          {loading ? (
            <p className="mt-2 text-sm text-[var(--muted-foreground)]">Loading history…</p>
          ) : trajectory.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--muted-foreground)]">
              No published swims in this event yet — this is their first.
            </p>
          ) : (
            <ol className="mt-2 flex list-none flex-col gap-1.5">
              {trajectory.map((point) => (
                <TrajectoryRow key={`${point.swamAt}-${point.officialTimeMs}`} point={point} />
              ))}
            </ol>
          )}
          {overallPb && (
            <p className="mt-2 font-telemetry text-xs" style={{ color: "var(--color-neon-lime)" }}>
              Personal best {formatTimeMs(overallPb.bestTimeMs)}
              {overallPb.volumeName ? ` · ${overallPb.volumeName}` : ""}
            </p>
          )}
        </section>

        {!loading && profile && profile.personalBests.length > 0 && (
          <section className="mt-5" aria-label="Personal bests across all events">
            <h3 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-widest text-[var(--muted-foreground)] uppercase">
              <Trophy className="size-3.5" aria-hidden />
              Every personal best
            </h3>
            <ul className="mt-2 flex list-none flex-col gap-1">
              {profile.personalBests.map((pb) => (
                <li
                  key={`${pb.stroke}-${pb.distanceM}`}
                  className="flex items-baseline justify-between gap-2 text-xs"
                >
                  <span className="truncate text-[var(--muted-foreground)]">
                    {pb.distanceM}m {pb.stroke}
                  </span>
                  <span className="font-telemetry font-bold tabular-nums">
                    {formatTimeMs(pb.bestTimeMs)}
                    <span className="ml-2 font-normal text-[var(--muted-foreground)]">
                      {formatWaPoints(pb.waPoints)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </motion.div>
    </motion.div>
    </TelemetryThemeScope>,
    document.body,
  );
}

function TrajectoryRow({ point }: { point: PbTrajectoryPoint }) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-xs">
      <span className="truncate text-[var(--muted-foreground)]">{point.volumeName}</span>
      <span className="flex shrink-0 items-baseline gap-2">
        <span className="font-telemetry font-bold tabular-nums">
          {formatTimeMs(point.officialTimeMs)}
        </span>
        {point.deltaMs != null && (
          <span
            className="font-telemetry tabular-nums"
            style={{
              color: point.deltaMs < 0 ? "var(--color-neon-lime)" : "var(--color-neon-orange)",
            }}
          >
            {point.deltaMs < 0 ? "−" : "+"}
            {(Math.abs(point.deltaMs) / 1000).toFixed(2)}s
          </span>
        )}
        {point.isPersonalBest && (
          <span
            className="rounded px-1 font-telemetry text-[10px] font-bold"
            style={{
              background: "color-mix(in oklch, var(--color-neon-lime) 18%, transparent)",
              color: "var(--color-neon-lime)",
            }}
          >
            PB
          </span>
        )}
      </span>
    </li>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold tracking-widest text-[var(--muted-foreground)] uppercase">
        {label}
      </p>
      <p className="font-telemetry text-sm font-bold tabular-nums" style={{ color: accent }}>
        {value}
      </p>
    </div>
  );
}
