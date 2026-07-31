"use client";

import { useState } from "react";
import { Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeatResultEntry, type HeatLaneAthlete } from "@/components/referee/heat-result-entry";
import { cn } from "@/lib/utils";

const DEMO_LANES: HeatLaneAthlete[] = [
  { heatLaneId: "hl-1", laneNumber: 1, athleteName: "Mia Reyes", teamName: "Blue Marlins", seedTimeMs: 31000 },
  { heatLaneId: "hl-2", laneNumber: 2, athleteName: "Noah Alvi", teamName: "Riptide", seedTimeMs: 30500 },
  { heatLaneId: "hl-3", laneNumber: 3, athleteName: "Zara Khan", teamName: "Blue Marlins", seedTimeMs: 29800 },
  { heatLaneId: "hl-4", laneNumber: 4, athleteName: "Leo Fontaine", teamName: "Tidal Wave", seedTimeMs: 29200 },
  { heatLaneId: "hl-5", laneNumber: 5, athleteName: "Ava Thompson", teamName: "Riptide", seedTimeMs: 31500 },
  { heatLaneId: "hl-6", laneNumber: 6, athleteName: "Kian Osei", teamName: "Tidal Wave", seedTimeMs: 32000 },
];

export default function RefereePage() {
  const [outdoorMode, setOutdoorMode] = useState(false);

  return (
    <main
      className={cn(
        "mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6",
        outdoorMode && "bg-black text-yellow-300",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className={cn("text-2xl font-bold tracking-tight", outdoorMode && "text-yellow-300")}>
            Referee heat entry
          </h1>
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
            Record Valid Time, DQ with official reason code, or NS (No-Show).
          </p>
        </div>
        <Button
          type="button"
          variant={outdoorMode ? "secondary" : "outline"}
          size="icon"
          className="size-11 min-h-[48px] min-w-[48px]"
          aria-pressed={outdoorMode}
          aria-label="Toggle high-contrast outdoor mode"
          onClick={() => setOutdoorMode((v) => !v)}
        >
          <Sun className="size-5" />
        </Button>
      </div>

      <HeatResultEntry
        heatId="demo-heat-1"
        heatLabel="Session 1 — 50 Free Heat 3"
        lanes={DEMO_LANES}
        outdoorMode={outdoorMode}
      />
    </main>
  );
}
