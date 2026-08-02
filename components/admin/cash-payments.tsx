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
  approveAndConfirmPayment,
  type PendingPaymentAthlete,
} from "@/lib/admin-cash-payments";

export function CashPayments({ className }: { className?: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<PendingPaymentAthlete[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAthleteId, setBusyAthleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchPendingCashPayments());
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
      const res = await approveAndConfirmPayment(row.athleteId, row.entryIds);
      if (!res.success) throw new Error(res.error ?? "Failed to confirm cash payment.");
      setRows((prev) => prev.filter((r) => r.athleteId !== row.athleteId));
      toast.success(
        "Swimmer approved & payment confirmed",
        `${row.athleteName} — ${row.totalEgp} EGP received.`,
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
          <CardTitle>Approvals & cash on deck</CardTitle>
          <CardDescription>
            Verify each swimmer&rsquo;s cash payment (300 EGP / race) at the meet desk, then confirm here.
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
                      <Badge variant="outline" className="gap-1.5">
                        <Banknote className="size-3.5" />
                        {row.totalEgp} EGP — Cash Payment Pending on Deck
                      </Badge>
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
                        Approve & Confirm Payment
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
