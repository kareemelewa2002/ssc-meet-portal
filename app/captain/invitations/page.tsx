"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Link2, Search, UserPlus, X } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { fetchMyManagedTeam } from "@/lib/teams";
import {
  createTeamInviteLink,
  fetchActiveInviteLink,
  fetchSentInvitations,
  inviteAthleteToTeam,
  revokeInvitation,
  revokeTeamInviteLink,
  searchUnattachedAthletes,
  type SentInvitation,
  type TeamInviteLink,
  type UnattachedAthleteResult,
} from "@/lib/team-invites";
import type { TeamRow } from "@/lib/supabase/types";

/**
 * Both invite directions live here: the shareable link for someone outside
 * the app entirely, and searching/inviting an existing unattached athlete
 * in-app — plus the list of sent invites still awaiting a response. See
 * lib/team-invites.ts's module comment for how the two differ underneath.
 */
export default function CaptainInvitationsPage() {
  const [team, setTeam] = useState<TeamRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  const [link, setLink] = useState<TeamInviteLink | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UnattachedAthleteResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [invitingUserId, setInvitingUserId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [sent, setSent] = useState<SentInvitation[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const myTeam = await fetchMyManagedTeam();
      if (cancelled) return;
      setTeam(myTeam.data);
      setDataError(myTeam.error);
      if (myTeam.data) {
        const [activeLink, sentInvites] = await Promise.all([
          fetchActiveInviteLink(myTeam.data.id),
          fetchSentInvitations(myTeam.data.id),
        ]);
        if (!cancelled) {
          setLink(activeLink);
          if (activeLink && typeof window !== "undefined") {
            setLinkUrl(`${window.location.origin}/register?invite=${activeLink.token}`);
          }
          setSent(sentInvites);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced athlete search.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const found = await searchUnattachedAthletes(query);
      setResults(found);
      setSearching(false);
    }, 350);
    return () => clearTimeout(handle);
  }, [query]);

  async function handleCreateOrRegenerateLink() {
    if (!team || typeof window === "undefined") return;
    setLinkBusy(true);
    const result = await createTeamInviteLink(team.id, window.location.origin);
    setLinkBusy(false);
    if (!result.data) return;
    setLinkUrl(result.data);
    const refreshed = await fetchActiveInviteLink(team.id);
    setLink(refreshed);
  }

  async function handleRevokeLink() {
    if (!link) return;
    setLinkBusy(true);
    await revokeTeamInviteLink(link.id);
    setLinkBusy(false);
    setLink(null);
    setLinkUrl(null);
  }

  async function handleCopyLink() {
    if (!linkUrl) return;
    await navigator.clipboard.writeText(linkUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleInvite(athlete: UnattachedAthleteResult) {
    if (!team) return;
    setInvitingUserId(athlete.userId);
    setInviteError(null);
    const result = await inviteAthleteToTeam(team.id, athlete.userId);
    setInvitingUserId(null);
    if (!result.success) {
      setInviteError(result.error ?? "Could not send that invite.");
      return;
    }
    setResults((prev) => prev.filter((r) => r.userId !== athlete.userId));
    // Re-fetched rather than appended locally with a fake id: revoking an
    // invite needs the real team_memberships row id, which only the server
    // assigns.
    setSent(await fetchSentInvitations(team.id));
  }

  async function handleRevokeInvite(id: string) {
    setRevokingId(id);
    await revokeInvitation(id);
    setRevokingId(null);
    setSent((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div className="min-h-screen">
      <AppHeader title="Invitations" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <Link
          href="/captain"
          className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Captain Dashboard
        </Link>
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Invite Athletes</h1>
          <p className="text-sm text-muted-foreground">
            Share a link with athletes outside the app, or invite an existing unattached athlete
            directly.
          </p>
        </header>

        <DataErrorBanner error={dataError} subject="your team" />

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : !team ? (
          <p className="text-sm text-muted-foreground">
            You&rsquo;re not currently registered as a team captain.
          </p>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link2 className="size-4" />
                  Shareable link
                </CardTitle>
                <CardDescription>
                  Anyone who signs up through this link joins {team.name} automatically — no
                  approval step, since sending the link is the approval.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {linkUrl ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-lg border-2 border-border-strong bg-muted/40 px-2.5 py-2 text-xs">
                        {linkUrl}
                      </code>
                      <Button type="button" size="sm" variant="outline" onClick={handleCopyLink}>
                        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                        {copied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Used {link?.useCount ?? 0} {link?.useCount === 1 ? "time" : "times"} so far.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={linkBusy}
                        onClick={handleCreateOrRegenerateLink}
                      >
                        Regenerate
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={linkBusy}
                        onClick={handleRevokeLink}
                      >
                        Revoke
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button type="button" disabled={linkBusy} onClick={handleCreateOrRegenerateLink}>
                    <Link2 className="size-4" />
                    Create invite link
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserPlus className="size-4" />
                  Invite an athlete on the website
                </CardTitle>
                <CardDescription>
                  Only athletes with no current team appear here — they must accept before joining
                  your roster.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="relative">
                  <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name…"
                    className="pl-8"
                    aria-label="Search unattached athletes"
                  />
                </div>
                {inviteError && (
                  <p className="text-xs font-semibold text-destructive">{inviteError}</p>
                )}
                {searching && <p className="text-xs text-muted-foreground">Searching…</p>}
                {!searching && query.trim().length >= 2 && results.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No unattached athlete matches &ldquo;{query}&rdquo;.
                  </p>
                )}
                {results.map((athlete) => (
                  <div
                    key={athlete.athleteId}
                    className="flex items-center justify-between gap-2 rounded-lg border-2 border-border-strong p-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{athlete.fullName}</p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {athlete.ageGroup} · {athlete.gender}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={invitingUserId === athlete.userId}
                      onClick={() => handleInvite(athlete)}
                    >
                      Invite
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Pending invitations</CardTitle>
                <CardDescription>
                  Direct invites you&rsquo;ve sent that the athlete hasn&rsquo;t responded to yet.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {sent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No pending invitations.</p>
                ) : (
                  sent.map((invite) => (
                    <div
                      key={invite.id}
                      className="flex items-center justify-between gap-2 rounded-lg border-2 border-border-strong p-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">{invite.fullName}</span>
                        <Badge variant="outline">Awaiting response</Badge>
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Revoke invitation to ${invite.fullName}`}
                        disabled={revokingId === invite.id}
                        onClick={() => handleRevokeInvite(invite.id)}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
