import { cn } from "@/lib/utils"

/**
 * Telemetry skeleton — a dim plate with a bright band sweeping across it,
 * like an instrument redrawing itself.
 *
 * Replaces the raw "Loading…" strings that used to sit on every surface.
 * Those were genuinely harmful here: a one-line string occupies almost no
 * space, so the page reflowed violently once data landed, and on the pool
 * deck a referee could not tell "still fetching" from "this heat is empty".
 * A skeleton reserves the real layout box and reads unambiguously as motion.
 *
 * The sweep is suppressed under prefers-reduced-motion (see globals.css) —
 * the plate still renders, it just stops moving.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "relative overflow-hidden rounded-lg border-2 border-border-strong/15 bg-muted",
        // The travelling band. Starts off-plate (-translate-x-full) and is
        // driven across by animate-scan.
        "after:absolute after:inset-y-0 after:left-0 after:w-1/3 after:-translate-x-full",
        "after:bg-gradient-to-r after:from-transparent after:via-white/75 after:to-transparent",
        "after:animate-scan",
        className
      )}
      {...props}
    />
  )
}

/** Roster / directory rows: avatar + two text lines + a trailing chip. */
function SkeletonRow({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border-2 border-border-strong/15 p-3", className)}>
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3 w-1/4" />
      </div>
      <Skeleton className="h-6 w-16 shrink-0 rounded-full" />
    </div>
  )
}

/** Heat sheet lanes: lane badge, swimmer, time readout. */
function SkeletonLane({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border-2 border-border-strong/15 p-3", className)}>
      <Skeleton className="size-11 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-1/5" />
      </div>
      <Skeleton className="h-5 w-20 shrink-0" />
    </div>
  )
}

/** Bento KPI tile: label over a large figure. */
function SkeletonStat({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2 rounded-2xl border-2 border-border-strong/15 p-4", className)}>
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-7 w-1/3" />
    </div>
  )
}

export { Skeleton, SkeletonRow, SkeletonLane, SkeletonStat }
