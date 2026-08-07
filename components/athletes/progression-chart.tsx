"use client";

import { useMemo } from "react";
import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTimeMs } from "@/lib/format";
import type { CareerResultView } from "@/lib/athletes";

/**
 * A swimmer's time, per event, across volumes — the "visual progression
 * chart" from the audit's recommendations.
 *
 * Hand-built SVG, not a charting library. This app has no charting
 * dependency anywhere, and the shape needed here — a handful of points on one
 * line, per event — does not need one. A generic library's default look
 * would also fight this app's own design tokens (the brutalist borders and
 * shadows used throughout) rather than match them.
 *
 * ONE CHART PER EVENT SHAPE (stroke + distance), never combined. A single
 * axis mixing a 50 Free and a 400 IM would be meaningless — the numbers live
 * on completely different scales and "improvement" would not read as
 * improvement. An event with only one result ever has nothing to show a
 * trend against, so it is skipped rather than rendered as a single dot.
 *
 * THE Y-AXIS IS INVERTED. A swimmer's improvement is a smaller number
 * (seconds), and plotting that literally would show every good season as a
 * downward line — the opposite of what "progression" should look like at a
 * glance. Faster times are placed higher, so the line reads the way a
 * results table already reads: better is up.
 */
export function ProgressionCharts({ results }: { results: CareerResultView[] }) {
  const groups = useMemo(() => {
    const byShape = new Map<string, CareerResultView[]>();
    for (const r of results) {
      // Only real times. A DQ or NS has no officialTimeMs and would either
      // break the scale or silently vanish from the line — excluded rather
      // than either.
      if (r.officialTimeMs == null) continue;
      const key = `${r.stroke}__${r.distanceM}`;
      const list = byShape.get(key) ?? [];
      list.push(r);
      byShape.set(key, list);
    }
    return [...byShape.entries()]
      .map(([key, list]) => ({
        key,
        stroke: list[0].stroke,
        distanceM: list[0].distanceM,
        points: [...list].sort((a, b) => a.volumeNumber - b.volumeNumber),
      }))
      .filter((g) => g.points.length >= 2)
      .sort((a, b) => a.distanceM - b.distanceM || a.stroke.localeCompare(b.stroke));
  }, [results]);

  if (groups.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="size-4" />
          Progression
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {groups.map((g) => (
          <EventTrend key={g.key} stroke={g.stroke} distanceM={g.distanceM} points={g.points} />
        ))}
      </CardContent>
    </Card>
  );
}

const WIDTH = 280;
const HEIGHT = 96;
const PAD_X = 12;
const PAD_Y = 16;

function EventTrend({
  stroke,
  distanceM,
  points,
}: {
  stroke: string;
  distanceM: number;
  points: CareerResultView[];
}) {
  const times = points.map((p) => p.officialTimeMs as number);
  const min = Math.min(...times);
  const max = Math.max(...times);
  // A flat line (every time identical) would divide by zero mapping to Y —
  // treated as its own single-height band down the middle instead.
  const span = max - min || 1;

  const plotW = WIDTH - PAD_X * 2;
  const plotH = HEIGHT - PAD_Y * 2;
  const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const t = p.officialTimeMs as number;
    // Inverted: the FASTEST time gets the SMALLEST y (closer to the top of
    // the SVG, which is the visually "higher" position).
    const norm = (t - min) / span;
    const x = PAD_X + i * stepX;
    const y = PAD_Y + norm * plotH;
    return { x, y, point: p };
  });

  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const improved = (points[points.length - 1].officialTimeMs as number) < (points[0].officialTimeMs as number);

  return (
    <div className="rounded-xl border-2 border-border-strong p-3 shadow-brutal-sm">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <p className="truncate text-xs font-bold uppercase tracking-wide">
          {distanceM}m {stroke}
        </p>
        <p className={improved ? "text-xs font-semibold text-emerald-600" : "text-xs text-muted-foreground"}>
          {formatTimeMs(points[points.length - 1].officialTimeMs as number)}
        </p>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-24 w-full"
        role="img"
        aria-label={`${distanceM}m ${stroke} time across ${points.length} meets, from ${formatTimeMs(points[0].officialTimeMs as number)} to ${formatTimeMs(points[points.length - 1].officialTimeMs as number)}`}
      >
        <path d={path} fill="none" stroke="currentColor" strokeWidth={2} className="text-neon-cyan" />
        {coords.map((c, i) => (
          <g key={i}>
            <circle cx={c.x} cy={c.y} r={3.5} className="fill-foreground" />
            <title>
              Vol. {c.point.volumeNumber} — {formatTimeMs(c.point.officialTimeMs as number)}
            </title>
          </g>
        ))}
      </svg>
      <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span>Vol. {points[0].volumeNumber}</span>
        <span>Vol. {points[points.length - 1].volumeNumber}</span>
      </div>
    </div>
  );
}
