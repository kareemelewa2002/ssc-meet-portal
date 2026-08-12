"use client";

import { useEffect, useState } from "react";
import { Image as ImageIcon, Loader2, Pencil } from "lucide-react";
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
import { uploadTeamLogo } from "@/lib/storage";
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
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Uploaded on pick rather than on submit, so the captain sees the actual
  // stored image before committing — and so a rejected file (wrong type, too
  // large) is reported immediately rather than after they fill in the rest of
  // the form and press Save.
  const handleLogoFile = async (file: File) => {
    setUploading(true);
    setErrors([]);
    try {
      const res = await uploadTeamLogo(team.id, file);
      if (!res.url) {
        setErrors([res.error ?? "Could not upload that image."]);
        return;
      }
      setLogoUrl(res.url);
    } finally {
      setUploading(false);
    }
  };

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
            <Label htmlFor="team-logo">Team logo</Label>
            <div className="flex items-center gap-3">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt=""
                  className="size-14 shrink-0 rounded-lg border-2 border-border-strong object-contain"
                />
              ) : (
                <div className="flex size-14 shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-border-strong text-muted-foreground">
                  <ImageIcon className="size-5" />
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-1.5">
                <Input
                  id="team-logo"
                  type="file"
                  // The picker itself is filtered to PNG, but the accept
                  // attribute is a hint a user can bypass — uploadTeamLogo()
                  // re-checks the MIME type, which is the check that counts.
                  accept="image/png"
                  disabled={uploading || saving}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleLogoFile(file);
                    // Reset, so re-picking the SAME file after a failed
                    // upload still fires a change event.
                    e.target.value = "";
                  }}
                  className="min-h-[44px]"
                />
                {logoUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs text-muted-foreground"
                    onClick={() => setLogoUrl("")}
                    disabled={uploading || saving}
                  >
                    Remove logo
                  </Button>
                )}
              </div>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {uploading && <Loader2 className="size-3.5 animate-spin" />}
              {uploading
                ? "Uploading…"
                : "PNG only, up to 2MB. PNG because a crest needs transparency — a JPEG arrives with a white box around it."}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={saving || uploading} className="gap-2">
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
