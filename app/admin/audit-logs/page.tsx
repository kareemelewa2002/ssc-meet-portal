"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { FilterSelect } from "@/components/events/filter-select";
import {
  fetchAdminActionActors,
  fetchAdminActionTypes,
  fetchAdminActions,
  type AdminAction,
} from "@/lib/audit-log";

/** Fixed, human labels for the action categories this app currently logs.
 * Falls back to the raw string for any future action type that has not been
 * given a label yet — see ACTION_LABELS below and TECH_STACK_DECISIONS.md. */
const ACTION_LABELS: Record<string, string> = {
  ROLE_CHANGE: "Role change",
  PAYMENT_OVERRIDE: "Payment override",
  PRICING_UPDATE: "Pricing update",
};

function actionBadgeVariant(action: string): "default" | "secondary" | "destructive" | "outline" {
  if (action === "ROLE_CHANGE") return "destructive";
  if (action === "PAYMENT_OVERRIDE") return "default";
  if (action === "PRICING_UPDATE") return "secondary";
  return "outline";
}

export default function AdminAuditLogsPage() {
  const [rows, setRows] = useState<AdminAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [actionTypes, setActionTypes] = useState<string[]>([]);
  const [actors, setActors] = useState<{ id: string; name: string }[]>([]);

  const [actionFilter, setActionFilter] = useState<string | null>(null);
  const [actorFilter, setActorFilter] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [types, people] = await Promise.all([fetchAdminActionTypes(), fetchAdminActionActors()]);
      if (!cancelled) {
        setActionTypes(types);
        setActors(people);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const result = await fetchAdminActions({
        action: actionFilter ?? undefined,
        actorId: actorFilter ?? undefined,
        // A bare YYYY-MM-DD date input is a local calendar day, not an
        // instant — end-of-day on "to" so the filter includes the whole day
        // the admin picked, not just its first millisecond.
        createdFrom: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined,
        createdTo: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined,
      });
      if (!cancelled) {
        setRows(result.data);
        setDataError(result.error);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actionFilter, actorFilter, dateFrom, dateTo]);

  const actionOptions = useMemo(
    () => actionTypes.map((a) => ({ value: a, label: ACTION_LABELS[a] ?? a })),
    [actionTypes],
  );
  const actorOptions = useMemo(
    () => actors.map((a) => ({ value: a.id, label: a.name })),
    [actors],
  );

  return (
    <div className="min-h-screen">
      <AppHeader title="Admin Audit Log" />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <Link
          href="/admin"
          className="inline-flex min-h-[48px] items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 size-4" /> Command Center
        </Link>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5" /> Admin Audit Log
            </CardTitle>
            <CardDescription>
              Every role change, payment override, and pricing change — append-only. Nothing here
              can be edited or deleted, including by an admin.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <FilterSelect
                label="Action"
                options={actionOptions}
                value={actionFilter}
                onChange={setActionFilter}
                outdoorMode={false}
              />
              <FilterSelect
                label="Admin"
                options={actorOptions}
                value={actorFilter}
                onChange={setActorFilter}
                outdoorMode={false}
              />
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  From
                </span>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="min-h-[48px]"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  To
                </span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="min-h-[48px]"
                />
              </div>
              {(actionFilter || actorFilter || dateFrom || dateTo) && (
                <div className="flex items-end">
                  <Button
                    variant="outline"
                    className="min-h-[48px]"
                    onClick={() => {
                      setActionFilter(null);
                      setActorFilter(null);
                      setDateFrom("");
                      setDateTo("");
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}
            </div>

            <DataErrorBanner error={dataError} subject="the audit log" />

            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : rows.length === 0 && !dataError ? (
              <p className="text-sm text-muted-foreground">
                No admin actions match these filters.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border-2 border-border-strong">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b-2 border-border-strong bg-muted/50 text-left">
                      <th className="w-8 p-2" />
                      <th className="p-2 font-semibold">Timestamp</th>
                      <th className="p-2 font-semibold">Admin</th>
                      <th className="p-2 font-semibold">Action</th>
                      <th className="p-2 font-semibold">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const expanded = expandedId === row.id;
                      return (
                        <Fragment key={row.id}>
                          <tr
                            className="cursor-pointer border-b border-border-strong/10 last:border-b-0 hover:bg-muted/30"
                            onClick={() => setExpandedId(expanded ? null : row.id)}
                          >
                            <td className="p-2 align-top text-muted-foreground">
                              {expanded ? (
                                <ChevronDown className="size-4" />
                              ) : (
                                <ChevronRight className="size-4" />
                              )}
                            </td>
                            <td className="p-2 align-top whitespace-nowrap">
                              {new Date(row.createdAt).toLocaleString()}
                            </td>
                            <td className="p-2 align-top">
                              <div className="font-medium">{row.actorName}</div>
                              {row.actorEmail && (
                                <div className="text-xs text-muted-foreground">{row.actorEmail}</div>
                              )}
                            </td>
                            <td className="p-2 align-top">
                              <Badge variant={actionBadgeVariant(row.action)}>
                                {ACTION_LABELS[row.action] ?? row.action}
                              </Badge>
                            </td>
                            <td className="p-2 align-top font-mono text-xs">
                              {row.targetTable}
                              {row.targetId ? ` #${row.targetId.slice(0, 8)}` : ""}
                            </td>
                          </tr>
                          {expanded && (
                            <tr className="border-b border-border-strong/10 bg-muted/20">
                              <td />
                              <td colSpan={4} className="p-3">
                                <pre className="overflow-x-auto rounded-md border border-border-strong/20 bg-background p-3 font-mono text-xs whitespace-pre-wrap">
                                  {JSON.stringify(row.details, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
