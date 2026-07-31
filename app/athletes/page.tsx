"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Trophy, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FilterPillGroup } from "@/components/events/filter-pill-group";
import {
  AGE_GROUP_LABELS,
  AWARD_TYPE_LABELS,
  fetchAthleteDirectory,
  filterAthletes,
  type AthleteDirectoryCard,
} from "@/lib/athletes";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

export default function AthletesDirectoryPage() {
  const [athletes, setAthletes] = useState<AthleteDirectoryCard[]>([]);
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState<Gender | null>(null);
  const [ageGroup, setAgeGroup] = useState<AgeGroup | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await fetchAthleteDirectory();
      if (!cancelled) {
        setAthletes(data);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(
    () => filterAthletes(athletes, { query, gender, ageGroup }),
    [athletes, query, gender, ageGroup],
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight">All athletes</h1>
          <Link
            href="/leaderboards/all-time"
            className="inline-flex min-h-[48px] items-center justify-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted"
          >
            <Trophy className="mr-2 size-4" />
            All-Time Records
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          Search the SSC roster by name or club. Tap a card for the full public profile.
        </p>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or club team…"
          className="min-h-[48px] pl-9"
          aria-label="Search athletes"
        />
      </div>

      <FilterPillGroup<Gender>
        label="Gender"
        value={gender}
        onChange={setGender}
        outdoorMode={false}
        options={[
          { value: "male", label: "Male" },
          { value: "female", label: "Female" },
        ]}
      />

      <FilterPillGroup<AgeGroup>
        label="Age group"
        value={ageGroup}
        onChange={setAgeGroup}
        outdoorMode={false}
        options={[
          { value: "U13_14", label: "U13-14" },
          { value: "U17", label: "U17" },
          { value: "Open", label: "Open" },
        ]}
      />

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading athletes…</p>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Users className="size-8 text-muted-foreground" />
            <p className="font-medium">No athletes match your filters</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((athlete) => {
            const initials = athlete.fullName
              .split(" ")
              .map((p) => p[0])
              .join("")
              .slice(0, 2)
              .toUpperCase();
            return (
              <Link key={athlete.id} href={`/athletes/${athlete.id}`} className="block">
                <Card className="h-full transition-colors hover:border-primary/40">
                  <CardContent className="flex gap-3 py-4">
                    <Avatar className="size-14">
                      {athlete.profileImageUrl ? (
                        <AvatarImage src={athlete.profileImageUrl} alt={athlete.fullName} />
                      ) : null}
                      <AvatarFallback>{initials}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate font-semibold">{athlete.fullName}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {athlete.teamName ?? "Unaffiliated"} · Age {athlete.age}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline">{AGE_GROUP_LABELS[athlete.ageGroup]}</Badge>
                        <Badge variant="outline" className="capitalize">
                          {athlete.gender}
                        </Badge>
                        <Badge variant="secondary">{athlete.eventsSwum} events</Badge>
                      </div>
                      {athlete.awards.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {athlete.awards.slice(0, 2).map((award) => (
                            <Badge key={award.id} className="text-[10px]">
                              {AWARD_TYPE_LABELS[award.awardType]} — Vol. {award.volumeNumber}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
