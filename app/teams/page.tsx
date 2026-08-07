"use client";

import { useEffect, useState } from "react";
import { Building2, Loader2, Lock, Plus, ShieldCheck, UserPlus, Users, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppHeader } from "@/components/layout/app-header";
import { PendingTeamApprovals } from "@/components/admin/pending-team-approvals";
import { TeamJoinRequests } from "@/components/teams/team-join-requests";
import { TeamAnnouncements } from "@/components/teams/team-announcements";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AthleteDirectory } from "@/components/athletes/athlete-directory";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkeletonRow } from "@/components/ui/skeleton";
import { firstError } from "@/lib/fetch-policy";
import {
  createTeam,
  fetchMyAthleteSummary,
  fetchTeamDetail,
  fetchTeams,
  type MyAthleteSummary,
  type TeamDetail,
} from "@/lib/teams";
import {
  cancelJoinRequest,
  fetchMyJoinRequest,
  fetchTransfersLocked,
  requestToJoinTeam,
  type MyJoinRequest,
} from "@/lib/team-memberships";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useToast } from "@/hooks/use-toast";
import type { TeamRow } from "@/lib/supabase/types";

const AGE_GROUP_LABELS: Record<string, string> = { U14: "14 & Under", U17: "17 & Under", Open: "Open" };

export default function TeamsPage() {
  const { user } = useCurrentUser();
  const toast = useToast();
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [abbreviation, setAbbreviation] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rosterTeam, setRosterTeam] = useState<TeamRow | null>(null);
  const [rosterDetail, setRosterDetail] = useState<TeamDetail | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [myAthlete, setMyAthlete] = useState<MyAthleteSummary | null>(null);
  const [myJoinRequest, setMyJoinRequest] = useState<MyJoinRequest | null>(null);
  const [joinBusyTeamId, setJoinBusyTeamId] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [transfersLocked, setTransfersLocked] = useState(false);
  const [view, setView] = useState<"teams" | "athletes">("teams");

  const canCaptainTeam =
    user?.role === "admin" || (user?.role === "athlete" && myAthlete?.ageGroup === "Open");

  const openRoster = async (team: TeamRow) => {
    setRosterTeam(team);
    setRosterLoading(true);
    const detail = await fetchTeamDetail(team.id);
    setRosterDetail(detail.data);
    if (detail.error) setDataError(detail.error);
    setRosterLoading(false);
  };

  const load = async () => {
    setLoading(true);
    const [teamsList, athleteSummary, joinRequest, locked] = await Promise.all([
      fetchTeams(),
      fetchMyAthleteSummary(),
      fetchMyJoinRequest(),
      fetchTransfersLocked(),
    ]);
    setTransfersLocked(locked);
    setTeams(teamsList.data);
    setMyAthlete(athleteSummary.data);
    setMyJoinRequest(joinRequest);
    setDataError(firstError(teamsList, athleteSummary));
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const handleRequestToJoin = async (team: TeamRow) => {
    setJoinBusyTeamId(team.id);
    try {
      const res = await requestToJoinTeam(team.id);
      if (!res.success) {
        toast.error("Couldn't send join request", res.error);
        return;
      }
      setMyJoinRequest({ id: "", teamId: team.id, teamName: team.name, status: "pending", requestedAt: new Date().toISOString() });
      toast.success("Join request sent", `${team.name}'s captain will review your request.`);
      void load();
    } finally {
      setJoinBusyTeamId(null);
    }
  };

  const handleCancelJoin = async () => {
    if (!myJoinRequest) return;
    setJoinBusyTeamId(myJoinRequest.teamId);
    try {
      const res = await cancelJoinRequest(myJoinRequest.id);
      if (!res.success) {
        toast.error("Couldn't cancel request", res.error);
        return;
      }
      setMyJoinRequest(null);
      toast.success("Join request canceled");
    } finally {
      setJoinBusyTeamId(null);
    }
  };

  const handleCreate = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Team name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setError("Sign in as a coach or team captain to create a team.");
        return;
      }
      const res = await createTeam({
        name,
        abbreviation: abbreviation || null,
        teamLogoUrl: logoUrl || null,
        captainId: user.id,
      });
      if (!res.success) {
        setError(res.error ?? "Failed to create team.");
        return;
      }
      setModalOpen(false);
      setName("");
      setAbbreviation("");
      setLogoUrl("");
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen">
      <AppHeader title="Team Directory" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
      {!loading && canCaptainTeam && (
        <div className="flex items-center justify-end gap-3">
          <Dialog open={modalOpen} onOpenChange={setModalOpen}>
            <DialogTrigger render={<Button className="min-h-[48px] gap-2" />}>
              <Plus className="size-4" />
              Create Team
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a new team</DialogTitle>
                <DialogDescription>
                  Teams exist permanently on the platform and require admin approval before they
                  can be selected as representation for a meet volume.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="teamName">Team name</Label>
                  <Input id="teamName" className="min-h-[48px]" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="abbr">Abbreviation</Label>
                  <Input id="abbr" className="min-h-[48px]" value={abbreviation} onChange={(e) => setAbbreviation(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="logo">Team logo URL</Label>
                  <Input id="logo" type="url" className="min-h-[48px]" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
                </div>
              </div>
              <DialogFooter>
                <Button className="min-h-[48px] w-full" disabled={submitting} onClick={() => void handleCreate()}>
                  {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Submit for approval
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}

      <Tabs value={view} onValueChange={(v) => setView(v as "teams" | "athletes")}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="teams" className="h-auto min-h-[48px] border-2 text-sm font-bold">
            Teams
          </TabsTrigger>
          <TabsTrigger value="athletes" className="h-auto min-h-[48px] border-2 text-sm font-bold">
            Athletes
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "athletes" ? (
        <AthleteDirectory />
      ) : (
      <>
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Teams</h1>
        <p className="text-sm text-muted-foreground">
          Teams are permanent on the platform, independent of any single meet volume.
        </p>
        {!loading && user?.role === "athlete" && !canCaptainTeam && (
          <p className="mt-1 text-xs text-muted-foreground">
            Only Open age-group (18+) athletes, coaches, or admins can create a team — browse and request to
            join one below instead.
          </p>
        )}
      </header>

      <DataErrorBanner error={dataError} subject="teams" onRetry={() => void load()} />

      {user?.role === "admin" && <PendingTeamApprovals />}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => (<SkeletonRow key={i} className="h-28 items-start" />))}</div>
      ) : teams.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {dataError ? "Team directory unavailable." : "No teams yet — be the first to create one."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {teams.map((team) => (
            <Card key={team.id}>
              <CardHeader className="flex-row items-center gap-3 space-y-0">
                <Avatar className="size-12">
                  {team.team_logo_url ? <AvatarImage src={team.team_logo_url} alt={team.name} /> : null}
                  <AvatarFallback>{team.abbreviation ?? team.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate">{team.name}</CardTitle>
                  <CardDescription>{team.abbreviation ?? "—"}</CardDescription>
                </div>
                {team.approved_by_admin ? (
                  <Badge className="gap-1">
                    <ShieldCheck className="size-3.5" />
                    Approved
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1">
                    <Building2 className="size-3.5" />
                    Pending
                  </Badge>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                <Button
                  variant="outline"
                  className="min-h-[44px] w-full gap-2"
                  onClick={() => void openRoster(team)}
                >
                  <Users className="size-4" />
                  View Roster & Captain Contact
                </Button>
                {user?.role === "athlete" &&
                  (myAthlete?.teamId === team.id ? (
                    <Badge variant="outline" className="w-full justify-center gap-1 py-2">
                      <ShieldCheck className="size-3.5" />
                      Your Team
                    </Badge>
                  ) : myJoinRequest?.teamId === team.id ? (
                    <Button
                      variant="outline"
                      className="min-h-[44px] w-full gap-2"
                      disabled={joinBusyTeamId === team.id}
                      onClick={() => void handleCancelJoin()}
                    >
                      {joinBusyTeamId === team.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <XCircle className="size-4" />
                      )}
                      Cancel Request (Pending)
                    </Button>
                  ) : transfersLocked && myAthlete?.teamId ? (
                    // The server refuses this outright while a meet is
                    // scheduled — say so instead of offering a button whose
                    // only outcome is an error toast.
                    <Badge
                      variant="outline"
                      className="w-full justify-center gap-1.5 border-2 border-border-strong bg-neon-orange/15 py-2 text-[11px]"
                    >
                      <Lock className="size-3.5" />
                      Transfers Locked Until Meet Ends
                    </Badge>
                  ) : (
                    <Button
                      className="min-h-[44px] w-full gap-2"
                      disabled={joinBusyTeamId === team.id || !!myJoinRequest}
                      onClick={() => void handleRequestToJoin(team)}
                    >
                      {joinBusyTeamId === team.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <UserPlus className="size-4" />
                      )}
                      Request to Join Team
                    </Button>
                  ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      </>
      )}

      <Dialog open={rosterTeam != null} onOpenChange={(open) => !open && setRosterTeam(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rosterTeam?.name}</DialogTitle>
            <DialogDescription>Captain contact and current member roster.</DialogDescription>
          </DialogHeader>
          {rosterLoading ? (
            <div className="space-y-2 py-2">{Array.from({ length: 4 }).map((_, i) => (<SkeletonRow key={i} />))}</div>
          ) : (
            <div className="space-y-4 py-2">
              {user && rosterTeam && user.id === rosterTeam.captain_id && (
                <TeamJoinRequests teamId={rosterTeam.id} />
              )}
              <div>
                <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Captain</p>
                {rosterDetail?.captain ? (
                  <div className="rounded-lg border-2 border-border-strong p-3 text-sm">
                    <p className="font-medium">{rosterDetail.captain.fullName}</p>
                    {rosterDetail.captain.email || rosterDetail.captain.phone ? (
                      <div className="mt-1 space-y-0.5 text-muted-foreground">
                        {rosterDetail.captain.email && <p>{rosterDetail.captain.email}</p>}
                        {rosterDetail.captain.phone && <p>{rosterDetail.captain.phone}</p>}
                      </div>
                    ) : (
                      // Deliberately explains the absence — a blank space
                      // reads as missing data rather than a privacy rule.
                      <p className="mt-1 text-xs text-muted-foreground">
                        Contact details are shared once you join this team, or while a join request
                        is pending between you.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No captain assigned yet.</p>
                )}
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Roster ({rosterDetail?.roster.length ?? 0})
                </p>
                {rosterDetail?.roster.length ? (
                  <ul className="max-h-64 space-y-1 overflow-y-auto">
                    {rosterDetail.roster.map((m) => (
                      <li
                        key={m.athleteId}
                        className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm"
                      >
                        <AthleteLink athleteId={m.athleteId} name={m.fullName} className="truncate" />
                        <span className="flex shrink-0 gap-1">
                          <Badge variant="outline" className="text-[10px]">
                            {AGE_GROUP_LABELS[m.ageGroup] ?? m.ageGroup}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {m.gender}
                          </Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No members yet.</p>
                )}
              </div>
              {rosterTeam && (
                <TeamAnnouncements
                  teamId={rosterTeam.id}
                  isCaptain={Boolean(user && user.id === rosterTeam.captain_id)}
                  authorId={user?.id ?? null}
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      </main>
    </div>
  );
}
