import { Crown, Medal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Marks a swim that tops a leaderboard.
 *
 * Two distinct badges, because they mean genuinely different things:
 *   - Best Overall  — the highest World Aquatics points anywhere in the meet
 *                     series. There is normally exactly one (more only on an
 *                     exact points tie).
 *   - Best in Event — the highest points within that one event. Every event
 *                     has one, so it is the more common badge by far.
 *
 * A swim that is best overall is necessarily also best in its event, so only
 * the stronger badge is shown — stacking both would just be noise.
 */
export function PerformanceBadges({
  isBestOverall,
  isBestInEvent,
  outdoorMode = false,
  className,
}: {
  isBestOverall?: boolean;
  isBestInEvent?: boolean;
  outdoorMode?: boolean;
  className?: string;
}) {
  if (!isBestOverall && !isBestInEvent) return null;

  if (isBestOverall) {
    return (
      <Badge
        title="Best performance overall — highest World Aquatics points in the series"
        className={cn(
          "h-5 gap-1 px-1.5 text-[10px] font-bold tracking-wide uppercase",
          outdoorMode
            ? "border-yellow-300 bg-yellow-300 text-black"
            : "border-black bg-neon-lime text-black",
          className,
        )}
      >
        <Crown className="size-3" />
        Best Overall
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      title="Best performance in this event — highest World Aquatics points for the event"
      className={cn(
        "h-5 gap-1 px-1.5 text-[10px] font-bold tracking-wide uppercase",
        outdoorMode && "border-yellow-300 text-yellow-300",
        className,
      )}
    >
      <Medal className="size-3" />
      Best in Event
    </Badge>
  );
}
