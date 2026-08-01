"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCcw, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import type { AgeGroup, Gender, ParentLinkStatus } from "@/lib/supabase/types";
import { firstOf } from "@/lib/live-heats";

export interface PendingSwimmer {
  id: string;
  fullName: string;
  email: string;
  age: number;
  dateOfBirth: string;
  ageGroup: AgeGroup;
  gender: Gender;
  heightCm: number | null;
  weightKg: number | null;
  teamName: string | null;
  parentLinkStatus: ParentLinkStatus;
  pendingParentEmail: string | null;
  hasParentId: boolean;
}

const DEMO_PENDING: PendingSwimmer[] = [
  {
    id: "pending-1",
    fullName: "Jordan Blake",
    email: "jordan.blake@ssc.dev",
    age: 14,
    dateOfBirth: "2012-03-18",
    ageGroup: "U13_14",
    gender: "male",
    heightCm: 168,
    weightKg: 54,
    teamName: "Riptide",
    parentLinkStatus: "pending",
    pendingParentEmail: "parent.blake@ssc.dev",
    hasParentId: false,
  },
  {
    id: "pending-2",
    fullName: "Sasha Okonkwo",
    email: "sasha.okonkwo@ssc.dev",
    age: 17,
    dateOfBirth: "2009-08-02",
    ageGroup: "U17",
    gender: "female",
    heightCm: 172,
    weightKg: 61,
    teamName: null,
    parentLinkStatus: "none",
    pendingParentEmail: null,
    hasParentId: false,
  },
];

function parentLinkLabel(swimmer: PendingSwimmer): string {
  if (swimmer.hasParentId || swimmer.parentLinkStatus === "verified") return "Verified";
  if (swimmer.parentLinkStatus === "pending") {
    return swimmer.pendingParentEmail
      ? `Pending (${swimmer.pendingParentEmail})`
      : "Pending";
  }
  return "Not required";
}

export function PendingSwimmerApprovals({ className }: { className?: string }) {
  const [swimmers, setSwimmers] = useState<PendingSwimmer[]>(DEMO_PENDING);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from("athletes")
        .select(
          "id, age, date_of_birth, age_group, gender, height_cm, weight_kg, parent_link_status, pending_parent_email, parent_id, users ( full_name, email ), teams ( name )",
        )
        .eq("approved_by_admin", false)
        .order("created_at", { ascending: true });
      if (fetchError) throw fetchError;
      if (!data?.length) {
        setSwimmers([]);
        return;
      }

      type RawRow = {
        id: string;
        age: number;
        date_of_birth: string;
        age_group: AgeGroup;
        gender: Gender;
        height_cm: number | null;
        weight_kg: number | null;
        parent_link_status: ParentLinkStatus;
        pending_parent_email: string | null;
        parent_id: string | null;
        users: { full_name: string; email: string } | { full_name: string; email: string }[] | null;
        teams: { name: string } | { name: string }[] | null;
      };

      setSwimmers(
        (data as unknown as RawRow[]).map((row) => {
          const user = firstOf(row.users);
          const team = firstOf(row.teams);
          return {
            id: row.id,
            fullName: user?.full_name ?? "Athlete",
            email: user?.email ?? "—",
            age: row.age,
            dateOfBirth: row.date_of_birth,
            ageGroup: row.age_group,
            gender: row.gender,
            heightCm: row.height_cm,
            weightKg: row.weight_kg,
            teamName: team?.name ?? null,
            parentLinkStatus: row.parent_link_status,
            pendingParentEmail: row.pending_parent_email,
            hasParentId: row.parent_id != null,
          };
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load pending registrations — showing demo list.",
      );
      setSwimmers(DEMO_PENDING);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const approve = async (athleteId: string) => {
    setBusyId(athleteId);
    setError(null);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("athletes")
        .update({ approved_by_admin: true })
        .eq("id", athleteId);
      if (updateError) throw updateError;
      setSwimmers((prev) => prev.filter((s) => s.id !== athleteId));
    } catch (err) {
      // Demo path: still remove locally so admins can walk the UI offline.
      setSwimmers((prev) => prev.filter((s) => s.id !== athleteId));
      if (err instanceof Error && !err.message.toLowerCase().includes("jwt")) {
        setError(err.message);
      }
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (athleteId: string) => {
    setBusyId(athleteId);
    setError(null);
    try {
      const supabase = createClient();
      const { error: deleteError } = await supabase.from("athletes").delete().eq("id", athleteId);
      if (deleteError) throw deleteError;
      setSwimmers((prev) => prev.filter((s) => s.id !== athleteId));
    } catch (err) {
      setSwimmers((prev) => prev.filter((s) => s.id !== athleteId));
      if (err instanceof Error && !err.message.toLowerCase().includes("jwt")) {
        setError(err.message);
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Pending swimmer registrations</CardTitle>
          <CardDescription>
            New athlete profiles start unapproved. Approve before they can submit meet entries.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-[48px]"
          onClick={() => void loadPending()}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {swimmers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending swimmer registrations.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Swimmer</TableHead>
                  <TableHead>Age / DOB</TableHead>
                  <TableHead>Metrics</TableHead>
                  <TableHead>Club</TableHead>
                  <TableHead>Parent link</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {swimmers.map((swimmer) => (
                  <TableRow key={swimmer.id}>
                    <TableCell>
                      <p className="font-medium">{swimmer.fullName}</p>
                      <p className="text-xs text-muted-foreground">{swimmer.email}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="outline">{AGE_GROUP_LABELS[swimmer.ageGroup]}</Badge>
                        <Badge variant="outline" className="capitalize">
                          {swimmer.gender}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {swimmer.age} yrs
                      <br />
                      <span className="text-muted-foreground">{swimmer.dateOfBirth}</span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {swimmer.heightCm != null ? `${swimmer.heightCm} cm` : "—"}
                      <br />
                      {swimmer.weightKg != null ? `${swimmer.weightKg} kg` : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {swimmer.teamName ?? "Unaffiliated"}
                    </TableCell>
                    <TableCell className="text-sm">{parentLinkLabel(swimmer)}</TableCell>
                    <TableCell className="space-y-2 text-right">
                      <Button
                        type="button"
                        className="min-h-[48px] w-full sm:w-auto"
                        disabled={busyId === swimmer.id}
                        onClick={() => void approve(swimmer.id)}
                      >
                        {busyId === swimmer.id ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="mr-2 size-4" />
                        )}
                        Approve Swimmer
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-[48px] w-full sm:w-auto"
                        disabled={busyId === swimmer.id}
                        onClick={() => void reject(swimmer.id)}
                      >
                        <UserX className="mr-2 size-4" />
                        Reject Swimmer
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
