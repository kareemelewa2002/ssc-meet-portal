"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn, getErrorMessage } from "@/lib/utils";
import type { SkinsCandidate } from "@/lib/skins-qualification";
import type { AgeGroup, SkinsResponse } from "@/lib/supabase/types";

const CATEGORY_LABELS: Record<AgeGroup, string> = {
  U14: "14 & Under",
  U17: "17 & Under",
  Open: "Open",
};

export interface SkinsQualificationModalProps {
  invitation: SkinsCandidate | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRespond?: (
    athleteId: string,
    category: AgeGroup,
    response: Exclude<SkinsResponse, "pending">,
  ) => Promise<void>;
  triggerLabel?: string;
  className?: string;
}

export function SkinsQualificationModal({
  invitation,
  open,
  onOpenChange,
  onRespond,
  triggerLabel = "Respond to Skins invite",
  className,
}: SkinsQualificationModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Exclude<SkinsResponse, "pending"> | null>(null);

  const handleRespond = async (response: Exclude<SkinsResponse, "pending">) => {
    if (!invitation || !onRespond) return;
    setBusy(true);
    setError(null);
    try {
      await onRespond(invitation.athleteId, invitation.category, response);
      setDone(response);
    } catch (err) {
      setError(getErrorMessage(err, "Could not save your response."));
    } finally {
      setBusy(false);
    }
  };

  const alreadyDecided = invitation?.response === "accepted" || invitation?.response === "declined";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open === undefined && (
        <DialogTrigger
          render={
            <Button
              type="button"
              className={cn("min-h-[48px]", className)}
              disabled={!invitation}
            />
          }
        >
          {triggerLabel}
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Session 3 — Skins Qualification</DialogTitle>
          <DialogDescription>
            Top-6 finishers qualify automatically. Declining rolls your slot to the next-fastest
            swimmer in your category.
          </DialogDescription>
        </DialogHeader>

        {!invitation ? (
          <p className="text-sm text-muted-foreground">No active Skins invitation right now.</p>
        ) : (
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{invitation.athleteName}</p>
                {invitation.teamName && (
                  <p className="text-sm text-muted-foreground">{invitation.teamName}</p>
                )}
              </div>
              <Badge variant="secondary">{CATEGORY_LABELS[invitation.category]}</Badge>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Meet rank</dt>
                <dd className="font-medium">#{invitation.sourceRank}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Best time</dt>
                <dd className="font-medium font-mono">
                  {(invitation.bestTimeMs / 1000).toFixed(2)}s
                </dd>
              </div>
            </dl>
            <Badge
              variant={
                invitation.response === "accepted"
                  ? "default"
                  : invitation.response === "declined"
                    ? "destructive"
                    : "outline"
              }
            >
              {invitation.response === "pending"
                ? "Awaiting response"
                : invitation.response === "accepted"
                  ? "Accepted"
                  : "Declined / Opt-out"}
            </Badge>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {done && (
          <Alert>
            <AlertDescription>
              {done === "accepted"
                ? "You're confirmed for Session 3 Skins. See you on the blocks."
                : "Opt-out recorded. Your slot will roll to the next qualifier."}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            type="button"
            className="min-h-[48px] w-full"
            disabled={!invitation || busy || alreadyDecided}
            onClick={() => void handleRespond("accepted")}
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}
            Accept Skins slot
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-[48px] w-full"
            disabled={!invitation || busy || alreadyDecided}
            onClick={() => void handleRespond("declined")}
          >
            <XCircle className="mr-2 size-4" />
            Decline / Opt-Out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
