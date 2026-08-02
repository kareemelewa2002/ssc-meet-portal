"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Medal, Search, Trophy } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AGE_GROUP_LABELS,
  AWARD_TYPE_LABELS,
  fetchAthleteProfile,
  filterCareerResults,
  type AthleteProfileView,
} from "@/lib/athletes";
import { formatTimeMs } from "@/lib/format";
import { DQ_REASON_LABELS } from "@/lib/results";
import { AppHeader } from "@/components/layout/app-header";
import { DataErrorBanner } from "@/components/ui/data-error-banner";

export default function AthleteProfilePage() {
  const params = useParams<{ id: string }>();
  const athleteId = params.id;
  const [profile, setProfile] = useState<AthleteProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [ledgerQuery, setLedgerQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchAthleteProfile(athleteId);
      if (!cancelled) {
        setProfile(result.data);
        setDataError(result.error);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [athleteId]);

  const ledger = useMemo(
    () => (profile ? filterCareerResults(profile.careerResults, ledgerQuery) : []),
    [profile, ledgerQuery],
  );

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl p-6 text-sm text-muted-foreground">Loading profile…</main>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen">
        <AppHeader title="Athlete Profile" />
        <main className="mx-auto max-w-4xl space-y-4 p-6">
          <Link href="/athletes" className="inline-flex min-h-[48px] items-center text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 size-4" /> All athletes
          </Link>
          <DataErrorBanner error={dataError} subject="this athlete profile" />
          {!dataError && <p className="font-medium">Athlete not found.</p>}
        </main>
      </div>
    );
  }

  const initials = profile.fullName
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="min-h-screen">
      <AppHeader title={profile.fullName} />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <Link
        href="/athletes"
        className="inline-flex min-h-[48px] items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 size-4" /> All athletes
      </Link>

      <Card>
        <CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center">
          <Avatar className="size-24">
            {profile.profileImageUrl ? (
              <AvatarImage src={profile.profileImageUrl} alt={profile.fullName} />
            ) : null}
            <AvatarFallback className="text-2xl">{initials}</AvatarFallback>
          </Avatar>
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">{profile.fullName}</h1>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">Age {profile.age}</Badge>
              <Badge variant="outline">{AGE_GROUP_LABELS[profile.ageGroup]}</Badge>
              <Badge variant="outline" className="capitalize">
                {profile.gender}
              </Badge>
              {profile.teamName && <Badge>{profile.teamName}</Badge>}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Medal className="size-5" /> Awards cabinet
          </CardTitle>
          <CardDescription>Meet awards across SSC volumes.</CardDescription>
        </CardHeader>
        <CardContent>
          {profile.awards.length === 0 ? (
            <p className="text-sm text-muted-foreground">No awards yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {profile.awards.map((award) => (
                <Badge key={award.id} className="min-h-[36px] px-3 text-sm">
                  {AWARD_TYPE_LABELS[award.awardType]} — {award.volumeName}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="size-5" /> Meet-to-meet rankings
          </CardTitle>
          <CardDescription>Series placement & improvement standing.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {profile.seriesStandings.map((standing) => (
            <div key={standing.category} className="rounded-lg border p-4">
              <p className="font-semibold">{AGE_GROUP_LABELS[standing.category]}</p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Placement rank</dt>
                  <dd className="font-medium">
                    {standing.placementRank != null ? `#${standing.placementRank}` : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Improvement rank</dt>
                  <dd className="font-medium">
                    {standing.improvementRank != null ? `#${standing.improvementRank}` : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Placement pts</dt>
                  <dd className="font-medium">{standing.placementPoints}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Improvement pts</dt>
                  <dd className="font-medium">{standing.improvementPoints}</dd>
                </div>
              </dl>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Personal bests</CardTitle>
          <CardDescription>Best SSC times per event.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>PB</TableHead>
                <TableHead>Age</TableHead>
                <TableHead>Volume</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.personalBests.map((pb) => (
                <TableRow key={`${pb.stroke}-${pb.distanceM}`}>
                  <TableCell>
                    {pb.distanceM} {pb.stroke}
                  </TableCell>
                  <TableCell className="font-mono">{formatTimeMs(pb.bestTimeMs)}</TableCell>
                  <TableCell>{pb.ageAtSwim}</TableCell>
                  <TableCell>{pb.volumeName ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Career results ledger</CardTitle>
          <CardDescription>
            Every official time, place, and DQ/NS across SSC volumes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={ledgerQuery}
              onChange={(e) => setLedgerQuery(e.target.value)}
              placeholder="Search event, stroke, volume, or status…"
              className="min-h-[48px] pl-9"
            />
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Volume</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Place</TableHead>
                  <TableHead>Split</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.volumeName}</TableCell>
                    <TableCell>{row.eventName}</TableCell>
                    <TableCell>{row.ageAtSwim}</TableCell>
                    <TableCell className="font-mono">
                      {formatTimeMs(row.officialTimeMs)}
                    </TableCell>
                    <TableCell>{row.finishPlace ?? "—"}</TableCell>
                    <TableCell className="font-mono">
                      {formatTimeMs(row.splitTimeMs)}
                    </TableCell>
                    <TableCell>
                      {row.outcome === "dq"
                        ? `DQ — ${row.dqCode ? DQ_REASON_LABELS[row.dqCode] : "DQ"}`
                        : row.outcome === "no_show"
                          ? "NS"
                          : "Valid"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      </main>
    </div>
  );
}
