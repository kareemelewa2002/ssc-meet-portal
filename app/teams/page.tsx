"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Building2, Loader2, Plus, ShieldCheck } from "lucide-react";
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
import { createTeam, fetchTeams } from "@/lib/teams";
import { createClient } from "@/lib/supabase/client";
import type { TeamRow } from "@/lib/supabase/types";

export default function TeamsPage() {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [abbreviation, setAbbreviation] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setTeams(await fetchTeams());
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

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
        clubLogoUrl: logoUrl || null,
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
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="flex min-h-[48px] items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          All Events
        </Link>
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
                <Label htmlFor="logo">Club logo URL</Label>
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

      <header>
        <h1 className="text-2xl font-bold tracking-tight">Teams</h1>
        <p className="text-sm text-muted-foreground">
          Teams are permanent on the platform, independent of any single meet volume.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading teams…</p>
      ) : teams.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No teams yet — be the first to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {teams.map((team) => (
            <Card key={team.id}>
              <CardHeader className="flex-row items-center gap-3 space-y-0">
                <Avatar className="size-12">
                  {team.club_logo_url ? <AvatarImage src={team.club_logo_url} alt={team.name} /> : null}
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
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
