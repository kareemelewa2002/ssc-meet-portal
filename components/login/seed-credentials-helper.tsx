"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/** Every quick login shares this. See supabase/seed-demo.sql §5b. */
const SEED_PASSWORD = "password123";

interface QuickLogin {
  label: string;
  email: string;
  note?: string;
}

/**
 * One working button per role — nothing else.
 *
 * This used to list the whole @ssc-demo.test roster: four groups, a dozen
 * rows, three separate team captains, "…through athlete36@ssc-demo.test"
 * ranges, and two accounts that exist solely to FAIL a gate (an unapproved
 * swimmer, and one awaiting parent linkage). Signing in as "an athlete"
 * meant choosing from six plausible-looking rows, two of which are designed
 * to be blocked — so the obvious guess could leave you at a permission wall
 * wondering what you had broken.
 *
 * Those fixtures still exist and the e2e suite still pins them; they are
 * documented in supabase/SEED_CREDENTIALS.md, which is the right home for a
 * reference list. A sign-in page wants the shortest path to being signed in.
 *
 * Mirrors supabase/seed-demo.sql §5b exactly — update both together.
 */
const QUICK_LOGINS: QuickLogin[] = [
  { label: "Admin", email: "admin@ssc.com", note: "cash desk, seeding, approvals" },
  { label: "Referee", email: "referee@ssc.com", note: "heat cards & time entry" },
  { label: "Team captain", email: "captain@ssc.com", note: "captains SSC Demo Club" },
  { label: "Athlete", email: "athlete@ssc.com", note: "Open age group" },
  { label: "Parent — one child", email: "parent@ssc.com", note: "one U14 swimmer" },
  { label: "Parent — several children", email: "parent-multi@ssc.com", note: "U14, U17 and Open" },
];

export function SeedCredentialsHelper({
  onUseCredentials,
}: {
  onUseCredentials: (email: string, password: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(SEED_PASSWORD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — the password is shown on-screen regardless.
    }
  };

  return (
    <Card>
      <CardHeader
        className="cursor-pointer flex-row items-center justify-between space-y-0 py-3"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <CardTitle className="text-sm">Quick logins</CardTitle>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Toggle quick logins"
        >
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4 pt-0">
          <CardDescription>
            One account per role, seeded by{" "}
            <code className="text-xs">supabase/seed-demo.sql</code>. Tap a row to fill the form
            above. These exist on demo and test databases only — a production database that has
            never had the demo seed applied will reject them.
          </CardDescription>

          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3">
            <div>
              <p className="text-xs text-muted-foreground">Password for every quick login</p>
              <p className="font-mono text-sm font-semibold">{SEED_PASSWORD}</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-[40px] gap-1.5"
              onClick={() => void copyPassword()}
            >
              <Copy className="size-3.5" />
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>

          <div className="space-y-1.5">
            {QUICK_LOGINS.map((entry) => (
              <button
                key={entry.email}
                type="button"
                className="flex min-h-[48px] w-full items-center justify-between gap-2 rounded-lg border p-2.5 text-left text-sm transition-colors hover:bg-muted/60"
                onClick={() => onUseCredentials(entry.email, SEED_PASSWORD)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{entry.label}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {entry.email}
                    {entry.note && <span className="text-muted-foreground/70"> · {entry.note}</span>}
                  </span>
                </span>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  Use
                </Badge>
              </button>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            The full @ssc-demo.test fixture roster — including the accounts that deliberately fail
            an approval or parent-linkage gate — is listed in{" "}
            <code className="text-xs">supabase/SEED_CREDENTIALS.md</code>.
          </p>
        </CardContent>
      )}
    </Card>
  );
}
