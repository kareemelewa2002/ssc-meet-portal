"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const SEED_PASSWORD = "Password123!";

interface CredentialEntry {
  label: string;
  email: string;
  note?: string;
}

interface CredentialGroup {
  group: string;
  entries: CredentialEntry[];
}

/** Mirrors supabase/seed-demo.sql exactly — update both together. */
const CREDENTIAL_GROUPS: CredentialGroup[] = [
  {
    group: "Superadmin / Meet Director",
    entries: [{ label: "Admin", email: "elewakareem2002@gmail.com" }],
  },
  {
    group: "Officials",
    entries: [
      {
        label: "Referee (attendance + time entry)",
        email: "referee1@ssc-demo.test",
        note: "…through referee8@ssc-demo.test",
      },
    ],
  },
  {
    group: "Coaches & Family",
    entries: [
      { label: "Coach — Riptide", email: "coach.riptide@ssc-demo.test" },
      { label: "Coach — Blue Marlins", email: "coach.marlins@ssc-demo.test" },
      { label: "Coach — Tidal Wave", email: "coach.tidalwave@ssc-demo.test" },
      { label: "Parent", email: "parent1@ssc-demo.test", note: "…through parent3@ssc-demo.test" },
    ],
  },
  {
    group: "Swimmers",
    entries: [
      { label: "U14 swimmer (ages 13–14)", email: "athlete01@ssc-demo.test", note: "…through athlete12@ssc-demo.test" },
      { label: "U17 swimmer (ages 15–17)", email: "athlete13@ssc-demo.test", note: "…through athlete24@ssc-demo.test" },
      { label: "Open swimmer (18+)", email: "athlete25@ssc-demo.test", note: "…through athlete36@ssc-demo.test" },
      { label: "Unapproved swimmer (approval gate test)", email: "athlete37@ssc-demo.test" },
      { label: "Pending parent-linkage swimmer (parent gate test)", email: "athlete38@ssc-demo.test" },
    ],
  },
];

export function SeedCredentialsHelper({
  onUseCredentials,
}: {
  onUseCredentials: (email: string, password: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(SEED_PASSWORD);
      setCopied("password");
      setTimeout(() => setCopied(null), 1500);
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
          <CardTitle className="text-sm">Seeded test credentials</CardTitle>
        </div>
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="Toggle credentials">
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4 pt-0">
          <CardDescription>
            Every account seeded by <code className="text-xs">supabase/seed-demo.sql</code> shares one
            password. Tap any row to fill in the sign-in form above.
          </CardDescription>

          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3">
            <div>
              <p className="text-xs text-muted-foreground">Password for every seeded account</p>
              <p className="font-mono text-sm font-semibold">{SEED_PASSWORD}</p>
            </div>
            <Button type="button" size="sm" variant="outline" className="min-h-[40px] gap-1.5" onClick={() => void copyPassword()}>
              <Copy className="size-3.5" />
              {copied === "password" ? "Copied" : "Copy"}
            </Button>
          </div>

          {CREDENTIAL_GROUPS.map((group) => (
            <div key={group.group} className="space-y-1.5">
              <p className="text-xs font-semibold uppercase text-muted-foreground">{group.group}</p>
              <div className="space-y-1.5">
                {group.entries.map((entry) => (
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
                        {entry.note && <span className="text-muted-foreground/70"> {entry.note}</span>}
                      </span>
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">Use</Badge>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
