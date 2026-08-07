"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, UserSearch } from "lucide-react";
import { formatTimeMs } from "@/lib/format";
import { formatWaPoints } from "@/lib/wa-points";
import { AGE_GROUP_SHORT_LABELS } from "@/lib/athletes";
import { DQ_REASON_LABELS } from "@/lib/results";
import type { TelemetryStanding } from "@/lib/telemetry";

/** Signed delta with an explicit sign, e.g. "−0.42" / "+1.08". A drop is
 * negative and reads as an improvement on the seed. */
function formatDelta(deltaMs: number): string {
  const sign = deltaMs < 0 ? "−" : "+";
  return `${sign}${(Math.abs(deltaMs) / 1000).toFixed(2)}s`;
}

function statusLabel(standing: TelemetryStanding): string | null {
  if (standing.outcome === "dq") {
    return standing.dqCode ? `DQ · ${DQ_REASON_LABELS[standing.dqCode]}` : "DQ";
  }
  if (standing.outcome === "no_show") return "No show";
  if (standing.awaitingApproval) return "Awaiting approval";
  return null;
}

/**
 * One swimmer on the event leaderboard. Collapsed it is a single telemetry
 * line — place, name, team, time, delta; expanded it adds the entry metadata
 * that does not deserve permanent screen space (heat, lane, seed, points,
 * age group) plus the way into the deep-dive modal.
 *
 * Expansion is the ONE place in this feature that animates `height` rather
 * than pure transform: the row below genuinely has to move, and a transform
 * cannot reflow the stack. It is scoped to a single detail panel per card and
 * `overflow-hidden` keeps it from painting outside — see
 * TECH_STACK_DECISIONS.md §12 for why this exception was accepted.
 */
export function StandingCard({
  standing,
  index,
  expanded,
  onToggle,
  onOpenProfile,
}: {
  standing: TelemetryStanding;
  /** Position in the rendered list, for the staggered entrance only — NOT the
   * finishing place, which is `standing.rank` and can be null or tied. */
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenProfile: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const status = statusLabel(standing);
  const panelId = `standing-panel-${standing.athleteId}-${standing.heatNumber}-${standing.laneNumber}`;

  return (
    <motion.li
      layout={reduceMotion ? false : "position"}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={
        reduceMotion
          ? { duration: 0.15 }
          : { type: "spring", stiffness: 300, damping: 28, delay: Math.min(index, 12) * 0.03 }
      }
      className="glass-hud overflow-hidden rounded-xl"
    >
      <motion.button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        whileTap={reduceMotion ? undefined : { scale: 0.99 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className="flex w-full min-h-[60px] items-center gap-3 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ outlineColor: "var(--color-neon-cyan)" }}
      >
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-lg font-telemetry text-base font-bold"
          style={{
            background:
              standing.rank === 1
                ? "color-mix(in oklch, var(--color-neon-lime) 25%, transparent)"
                : "color-mix(in oklch, var(--color-neon-cyan) 14%, transparent)",
            color: standing.rank === 1 ? "var(--color-neon-lime)" : "var(--color-neon-cyan)",
          }}
          aria-label={standing.rank == null ? "Unranked" : `Place ${standing.rank}`}
        >
          {standing.rank ?? "—"}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{standing.athleteName}</span>
          <span className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <span className="truncate">{standing.teamName ?? "Unattached"}</span>
            <span
              className="shrink-0 rounded px-1 font-telemetry text-[10px] font-bold"
              style={{
                background: "color-mix(in oklch, var(--foreground) 10%, transparent)",
                color: "var(--muted-foreground)",
              }}
            >
              {AGE_GROUP_SHORT_LABELS[standing.ageGroup]}
            </span>
          </span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {status ? (
            <span
              className="font-telemetry text-xs font-bold"
              style={{ color: "var(--color-neon-orange)" }}
            >
              {status}
            </span>
          ) : (
            <span className="font-telemetry text-sm font-bold tabular-nums">
              {formatTimeMs(standing.officialTimeMs)}
            </span>
          )}
          {standing.deltaMs != null && (
            <span
              className="font-telemetry text-xs tabular-nums"
              style={{
                color:
                  standing.deltaMs < 0 ? "var(--color-neon-lime)" : "var(--color-neon-orange)",
              }}
            >
              {formatDelta(standing.deltaMs)}
            </span>
          )}
        </span>

        <motion.span
          aria-hidden
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={
            reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 30 }
          }
          className="shrink-0 text-[var(--muted-foreground)]"
        >
          <ChevronDown className="size-4" />
        </motion.span>
      </motion.button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={panelId}
            key="panel"
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={
              reduceMotion ? { duration: 0.12 } : { type: "spring", stiffness: 320, damping: 34 }
            }
            className="overflow-hidden"
          >
            <div
              className="grid grid-cols-2 gap-x-4 gap-y-2 border-t px-3 py-3 sm:grid-cols-4"
              style={{ borderColor: "var(--border)" }}
            >
              <Metric label="Heat" value={String(standing.heatNumber)} />
              <Metric label="Lane" value={String(standing.laneNumber)} />
              <Metric
                label="Seed"
                value={standing.isNt ? "NT" : formatTimeMs(standing.seedTimeMs)}
              />
              <Metric label="WA points" value={formatWaPoints(standing.waPoints)} />
            </div>
            <div className="px-3 pb-3">
              <motion.button
                type="button"
                onClick={onOpenProfile}
                whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  background: "color-mix(in oklch, var(--color-neon-cyan) 16%, transparent)",
                  color: "var(--color-neon-cyan)",
                  outlineColor: "var(--color-neon-cyan)",
                }}
              >
                <UserSearch className="size-4" aria-hidden />
                Swimmer profile
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold tracking-widest text-[var(--muted-foreground)] uppercase">
        {label}
      </p>
      <p className="font-telemetry text-sm font-bold tabular-nums">{value}</p>
    </div>
  );
}
