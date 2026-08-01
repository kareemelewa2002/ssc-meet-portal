"use client";

import { useEffect, useState } from "react";
import { Eye, Shield, Sun, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HeatResultEntry, type HeatLaneAthlete } from "@/components/referee/heat-result-entry";
import { AttendanceBoard } from "@/components/referee/attendance-board";
import { useLanePresence } from "@/hooks/use-lane-presence";
import { useCurrentUser } from "@/hooks/use-current-user";
import { AppHeader } from "@/components/layout/app-header";
import {
  LANE_NUMBERS,
  findLaneOccupant,
  type LaneNumber,
} from "@/lib/referee-lanes";
import { cn } from "@/lib/utils";

const DEMO_LANES: HeatLaneAthlete[] = [
  { heatLaneId: "hl-1", laneNumber: 1, athleteName: "Mia Reyes", teamName: "Blue Marlins", seedTimeMs: 31000, athleteId: "ath-mia", attendanceStatus: "pending" },
  { heatLaneId: "hl-2", laneNumber: 2, athleteName: "Noah Alvi", teamName: "Riptide", seedTimeMs: 30500, athleteId: "ath-noah", attendanceStatus: "present" },
  { heatLaneId: "hl-3", laneNumber: 3, athleteName: "Zara Khan", teamName: "Blue Marlins", seedTimeMs: 29800, athleteId: "ath-zara", attendanceStatus: "pending" },
  { heatLaneId: "hl-4", laneNumber: 4, athleteName: "Leo Fontaine", teamName: "Tidal Wave", seedTimeMs: 29200, athleteId: "ath-leo", attendanceStatus: "present" },
  { heatLaneId: "hl-5", laneNumber: 5, athleteName: "Ava Thompson", teamName: "Riptide", seedTimeMs: 31500, athleteId: "ath-ava", attendanceStatus: "absent" },
  { heatLaneId: "hl-6", laneNumber: 6, athleteName: "Kian Osei", teamName: "Tidal Wave", seedTimeMs: 32000, athleteId: "ath-kian", attendanceStatus: "pending" },
];

const HEAT_ID = "demo-heat-1";

function getOrCreateRefereeId(): string {
  if (typeof window === "undefined") return "ssr-ref";
  const key = "ssc-ref-id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}

export default function RefereePage() {
  const [outdoorMode, setOutdoorMode] = useState(false);
  const [refereeName, setRefereeName] = useState("Deck Referee");
  const [refereeId, setRefereeId] = useState("ssr-ref");
  const { user } = useCurrentUser();

  useEffect(() => {
    setRefereeId(getOrCreateRefereeId());
  }, []);

  useEffect(() => {
    if (user?.fullName) setRefereeName(user.fullName);
  }, [user?.fullName]);

  const presence = useLanePresence({
    heatId: HEAT_ID,
    refereeId,
    refereeName: refereeName.trim() || "Deck Referee",
  });

  return (
    <div className={cn("min-h-screen", outdoorMode && "bg-black text-yellow-300")}>
      <AppHeader title="Referee Deck" className={cn(outdoorMode && "border-yellow-300/30 bg-black/95")} />
      <main
        className={cn(
          "mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6",
        )}
      >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className={cn("text-2xl font-bold tracking-tight", outdoorMode && "text-yellow-300")}>
            Referee heat entry
          </h1>
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
            Claim a lane, observe read-only, or enter Chief Referee mode for full overrides.
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

      <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
        <CardHeader>
          <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>
            Deck role & lane lock
          </CardTitle>
          <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
            Lane 1–6 claims are exclusive via realtime presence. Occupied lanes show who holds them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ref-name">Your name (shown on lane locks)</Label>
            <Input
              id="ref-name"
              className="min-h-[48px]"
              value={refereeName}
              onChange={(e) => setRefereeName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {LANE_NUMBERS.map((lane) => {
              const occupant = findLaneOccupant(presence.occupants, lane);
              const mine = presence.mode === "lane" && presence.focusedLane === lane;
              const blocked = occupant != null && occupant.refereeId !== refereeId;
              return (
                <Button
                  key={lane}
                  type="button"
                  variant={mine ? "default" : "outline"}
                  disabled={blocked}
                  className="min-h-[56px] flex-col gap-1"
                  onClick={() => void presence.selectMode("lane", lane as LaneNumber)}
                >
                  <span className="font-semibold">Lane {lane}</span>
                  {blocked && (
                    <Badge variant="destructive" className="max-w-full truncate text-[10px]">
                      Active by {occupant.refereeName}
                    </Badge>
                  )}
                  {mine && <Badge className="text-[10px]">Your lane</Badge>}
                </Button>
              );
            })}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant={presence.mode === "chief" ? "default" : "outline"}
              className="min-h-[48px]"
              onClick={() => void presence.selectMode("chief")}
            >
              <Shield className="mr-2 size-4" />
              Chief / Main Referee
            </Button>
            <Button
              type="button"
              variant={presence.mode === "observer" ? "secondary" : "outline"}
              className="min-h-[48px]"
              onClick={() => void presence.selectMode("observer")}
            >
              <Eye className="mr-2 size-4" />
              Substitute / Observer
            </Button>
          </div>

          {(presence.mode !== "observer" || presence.focusedLane != null) && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-[48px] w-full"
              onClick={() => void presence.release()}
            >
              <Unlock className="mr-2 size-4" />
              Release lane / return to observer
            </Button>
          )}

          {presence.claimError && (
            <p className="text-sm text-destructive" role="alert">
              {presence.claimError}
            </p>
          )}

          <p className={cn("text-xs", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
            Active mode:{" "}
            <strong>
              {presence.mode === "lane"
                ? `Lane ${presence.focusedLane}`
                : presence.mode === "chief"
                  ? "Chief Referee"
                  : "Observer (read-only)"}
            </strong>
          </p>
        </CardContent>
      </Card>

      <AttendanceBoard outdoorMode={outdoorMode} />

      <HeatResultEntry
        heatId={HEAT_ID}
        heatLabel="Session 1 — 50 Free Heat 3"
        lanes={DEMO_LANES}
        outdoorMode={outdoorMode}
        mode={presence.mode}
        focusedLane={presence.focusedLane}
        readOnly={presence.mode === "observer"}
        allowPublish={presence.mode === "chief"}
      />
      </main>
    </div>
  );
}
