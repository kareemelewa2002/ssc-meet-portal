"use client";

import { useEffect, useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { TEAM_ABBREVIATION_MAX, updateTeamBranding, validateTeamBranding } from "@/lib/teams";
import type { TeamRow } from "@/lib/supabase/types";

/**
 * A captain editing their own team's identity: name, abbreviation, logo.
 *
 * RLS (captain_update_own_team) is what actually permits this — the policy
 * has existed since the schema was written, but nothing in the app ever
 * exercised it, so a captain could not change their own team's name.
 */
export function EditTeamModal({
  team,
  onSaved,
}: {
  team: TeamRow;
  /** Called after a successful write so the parent can refresh its copy. */
  onSaved: (updated: { name: string; abbreviation: string | null; teamLogoUrl: string | null }) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team.name);
  const [abbreviation, setAbbreviation] = useState(team.abbreviation ?? "");
  const [logoUrl, setLogoUrl] = useState(team.team_logo_url ?? "");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Re-seed the form whenever it is opened, so a cancelled edit does not
  // leave stale values behind for the next open, and so an edit made in
  // another tab is reflected rather than silently overwritten.
  useEffect(() => {
    if (!open) return;
    setName(team.name);
    setAbbreviation(team.abbreviation ?? "");
    setLogoUrl(team.team_logo_url ?? "");
    setErrors([]);
  }, [open, team.name, team.abbreviation, team.team_logo_url]);

  const submit = async () => {
    const input = { name, abbreviation, logoUrl };
    // Checked here so the messages appear inline next to the fields; the
    // write path re-checks rather than trusting this ran.
    const check = validateTeamBranding(input);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }

    setSaving(true);
    try {
      const res = await updateTeamBranding(team.id, input);
      if (!res.success) {
        setErrors([res.error ?? "Could not save your changes."]);
        return;
      }
      toast.success("Team updated", `${check.values.name} has been saved.`);
      onSaved(check.values);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        className="min-h-[44px] gap-2"
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-4" />
        Edit Team Info
      </Button>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit team info</DialogTitle>
          <DialogDescription>
            How your team appears across heat sheets, results and the team list.
          </DialogDescription>
        </DialogHeader>

        {errors.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="list-inside list-disc space-y-1">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="team-name">Team name</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Riptide Swim Club"
              className="min-h-[44px]"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="team-abbr">Abbreviation</Label>
            <Input
              id="team-abbr"
              value={abbreviation}
              // Uppercased as it is typed, so what the field shows is exactly
              // what gets stored — rather than silently transforming the
              // value on save into something the captain never saw.
              onChange={(e) => setAbbreviation(e.target.value.toUpperCase())}
              placeholder="RIP"
              maxLength={TEAM_ABBREVIATION_MAX}
              className="min-h-[44px] font-mono uppercase"
            />
            <p className="text-xs text-muted-foreground">
              Up to {TEAM_ABBREVIATION_MAX} letters or numbers, shown where a full name will not
              fit. Optional.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="team-logo">Logo URL</Label>
            <Input
              id="team-logo"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://example.com/logo.png"
              inputMode="url"
              className="min-h-[44px]"
            />
            <p className="text-xs text-muted-foreground">
              Must be an https:// address — an http image is blocked as mixed content and would
              never load. Optional.
            </p>
            {/* Shown only once it passes validation, so a half-typed URL does
                not produce a broken-image icon on every keystroke. */}
            {/^https:\/\/\S+$/i.test(logoUrl.trim()) && (
              <div className="flex items-center gap-2 pt-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoUrl.trim()}
                  alt=""
                  className="size-10 rounded-lg border-2 border-border-strong object-contain"
                />
                <span className="text-xs text-muted-foreground">Preview</span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={saving} className="gap-2">
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
