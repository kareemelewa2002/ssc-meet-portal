"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FilterPillGroup } from "@/components/events/filter-pill-group";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkeletonRow } from "@/components/ui/skeleton";
import {
  AGE_GROUP_LABELS,
  AWARD_TYPE_LABELS,
  fetchAthleteDirectory,
  filterAthletes,
  type AthleteDirectoryCard,
} from "@/lib/athletes";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

/**
 * The searchable athlete directory.
 *
 * Extracted so /athletes and the Athletes tab on /teams render the same
 * thing — the nav calls that page "Teams & Athletes", and it previously
 * showed only teams.
 */
export function AthleteDirectory() {
  const [athletes, setAthletes] = useState<AthleteDirectoryCard[]>([]);
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState<Gender | null>(null);
  const [ageGroup, setAgeGroup] = useState<AgeGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchAthleteDirectory();
      if (!cancelled) {
        setAthletes(result.data);
        setDataError(result.error);
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
    <div className="flex flex-col gap-4">
      <DataErrorBanner error={dataError} subject="the athlete directory" />

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or team…"
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
          { value: "U14", label: "U14" },
          { value: "U17", label: "U17" },
          { value: "Open", label: "Open" },
        ]}
      />

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">{Array.from({ length: 6 }).map((_, i) => (<SkeletonRow key={i} />))}</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Users className="size-8 text-muted-foreground" />
            <p className="font-medium">
              {dataError ? "Athlete directory unavailable" : "No athletes match your filters"}
            </p>
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
    </div>
  );
}
