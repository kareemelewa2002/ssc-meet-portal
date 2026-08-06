"use client";

import { useCallback, useEffect, useState } from "react";
import { Banknote, CheckCircle2, Loader2, RefreshCcw } from "lucide-react";
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
import { getErrorMessage } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { AthleteLink } from "@/components/athletes/athlete-link";
import {
  fetchPendingCashPayments,
  confirmCashPayment,
  type PendingPaymentAthlete,
} from "@/lib/admin-cash-payments";
import { fetchActiveVolume } from "@/lib/volumes";
import { formatEgp, priceLineKindLabel } from "@/lib/pricing";
import { tierLabel } from "@/lib/pricing";
import { createClient } from "@/lib/supabase/client";

export function CashPayments({ className }: { className?: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<PendingPaymentAthlete[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [volumeId, setVolumeId] = useState<string | null>(null);
  const [busyAthleteId, setBusyAthleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The desk cannot take money without a volume to price against. No
      // fallback: an admin collecting cash against a guessed figure is exactly
      // the plausible-looking wrong the fail-loud policy exists to prevent.
      const vol = await fetchActiveVolume();
      if (!vol.data) {
        setError(vol.error ?? "No active meet volume, so there is no price to charge.");
        setRows([]);
        return;
      }
      setVolumeId(vol.data.id);
      // Each swimmer is priced by the database, at the tier in force right
      // now — the price settles when they pay, not when they registered.
      setRows(await fetchPendingCashPayments(vol.data.id));
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load pending cash payments."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmPaid = async (row: PendingPaymentAthlete) => {
    setBusyAthleteId(row.athleteId);
    setError(null);
    try {
      if (!volumeId || !row.tier || !row.pricingComplete) {
        throw new Error(
          "This swimmer has no complete quote, so there is no figure to collect against.",
        );
      }

      // Who took the money is part of the record, not decoration: a cash desk
      // with no attribution cannot be reconciled afterwards.
      const { data: auth } = await createClient().auth.getUser();

      const res = await confirmCashPayment({
        athleteId: row.athleteId,
        meetVolumeId: volumeId,
        entryIds: row.entryIds,
        amountEgp: row.totalEgp,
        tier: row.tier,
        lines: row.lines,
        collectedBy: auth.user?.id ?? null,
      });
      if (!res.success) throw new Error(res.error ?? "Failed to confirm cash payment.");
      setRows((prev) => prev.filter((r) => r.athleteId !== row.athleteId));
      toast.success(
        "Payment confirmed — heats seeded",
        `${row.athleteName} — ${formatEgp(row.totalEgp)} received at the ${tierLabel(row.tier)} rate. Their races are now in the heat sheet.`,
      );
    } catch (err) {
      const message = getErrorMessage(err, "Failed to confirm cash payment.");
      setError(message);
      toast.error("Failed to confirm payment", message);
    } finally {
      setBusyAthleteId(null);
    }
  };

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Cash on deck</CardTitle>
          <CardDescription>
            Verify each swimmer&rsquo;s cash payment at the meet desk, then confirm here.
            Each total is their package at the tier in force right now, plus any race
            surcharges — expand a row to see the breakdown. Confirming records what was
            collected and seeds their races into the heat sheet. Relay squads are paid
            separately by the team captain, below.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-[48px]"
          onClick={() => void load()}
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

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cash payments pending.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Swimmer</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Races entered</TableHead>
                  <TableHead>Amount due</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.athleteId}>
                    <TableCell className="font-medium">
                      <AthleteLink athleteId={row.athleteId} name={row.athleteName} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.teamName ?? "Unaffiliated"}</TableCell>
                    <TableCell>
                      <div className="flex max-w-[22rem] flex-wrap gap-1">
                        {row.raceNames.length === 0 ? (
                          <span className="text-muted-foreground">{row.raceCount}</span>
                        ) : (
                          row.raceNames.map((name) => (
                            <Badge key={name} variant="outline" className="max-w-full truncate text-[10px]">
                              {name}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={row.pricingComplete ? "outline" : "destructive"}
                        className="gap-1.5"
                      >
                        <Banknote className="size-3.5" />
                        {row.pricingComplete && row.tier
                          ? `${formatEgp(row.totalEgp)} — ${tierLabel(row.tier)} rate, pending on deck`
                          : "Price unavailable — do not collect until this loads"}
                      </Badge>
                      {/* The derivation, not just the figure. A swimmer at the
                          desk asking "why this much?" gets an answer without
                          the admin having to recompute it — and what is shown
                          here is exactly what gets stored as the receipt. */}
                      {row.pricingComplete && row.lines.length > 0 && (
                        <dl className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                          {row.lines.map((line, i) => (
                            <div key={`${line.kind}-${i}`} className="flex justify-between gap-3">
                              <dt className="truncate">
                                <span className="opacity-60">{priceLineKindLabel(line.kind)}:</span>{" "}
                                {line.label}
                              </dt>
                              <dd className="shrink-0 tabular-nums">{formatEgp(line.amountEgp)}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        className="min-h-[48px] gap-2"
                        disabled={busyAthleteId === row.athleteId}
                        onClick={() => void confirmPaid(row)}
                      >
                        {busyAthleteId === row.athleteId ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="size-4" />
                        )}
                        Confirm Payment
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
