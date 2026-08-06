"use client";

import { useCallback, useEffect, useState } from "react";
import { Banknote, CheckCircle2, Loader2, RefreshCcw, Users } from "lucide-react";
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
import {
  fetchPendingRelaySquadPayments,
  confirmRelaySquadPayment,
  type RelaySquadPayment,
} from "@/lib/relay-payments";
import { formatEgp } from "@/lib/pricing";
import { createClient } from "@/lib/supabase/client";

/**
 * The relay half of the cash desk — kept as its own card rather than folded
 * into <CashPayments>, because it is a genuinely different payer. Individual
 * entries are billed to and paid by each swimmer; a relay squad is billed to
 * and paid by the team captain, one payment per squad. Mixing the two into
 * one table would make "who pays this line" ambiguous at a glance, which is
 * exactly the wrong thing to be unclear about at a desk handling cash.
 *
 * Every squad listed here is complete (4/4 legs) by construction —
 * public.validate_relay_squad() refuses to let an incomplete squad exist in
 * the database at all, so there is no "partially filled" state to filter out
 * or warn about.
 */
export function RelaySquadPayments({ className }: { className?: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<RelaySquadPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySquadId, setBusySquadId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPendingRelaySquadPayments();
      setRows(result.data);
      setError(result.error);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load pending relay payments."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmPaid = async (row: RelaySquadPayment) => {
    setBusySquadId(row.squadId);
    setError(null);
    try {
      const { data: auth } = await createClient().auth.getUser();
      const res = await confirmRelaySquadPayment({
        squadId: row.squadId,
        collectedBy: auth.user?.id ?? "",
      });
      if (!res.success) throw new Error(res.error ?? "Failed to confirm relay payment.");
      setRows((prev) => prev.filter((r) => r.squadId !== row.squadId));
      toast.success(
        "Relay payment confirmed",
        `${row.teamName} — Squad ${row.squadLetter} (${row.eventName}), ` +
          `${formatEgp(row.currentQuoteEgp ?? 0)} received.`,
      );
    } catch (err) {
      const message = getErrorMessage(err, "Failed to confirm relay payment.");
      setError(message);
      toast.error("Failed to confirm payment", message);
    } finally {
      setBusySquadId(null);
    }
  };

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4" />
            Relay squad payments
          </CardTitle>
          <CardDescription>
            Each relay squad is billed to its team captain as one payment, not split
            across the four swimmers. Confirming here marks the whole squad paid.
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
          <p className="text-sm text-muted-foreground">No relay payments pending.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team</TableHead>
                  <TableHead>Captain</TableHead>
                  <TableHead>Squad</TableHead>
                  <TableHead>Amount due</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.squadId}>
                    <TableCell className="font-medium">{row.teamName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.captainName ?? "No captain on record"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="max-w-full truncate text-[10px]">
                        {row.eventName} — Squad {row.squadLetter}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="gap-1.5">
                        <Banknote className="size-3.5" />
                        {row.currentQuoteEgp != null
                          ? `${formatEgp(row.currentQuoteEgp)} — pending on deck`
                          : "Price unavailable — do not collect until this loads"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        className="min-h-[48px] gap-2"
                        disabled={busySquadId === row.squadId || row.currentQuoteEgp == null}
                        onClick={() => void confirmPaid(row)}
                      >
                        {busySquadId === row.squadId ? (
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
