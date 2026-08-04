"use client";

import { AlertTriangle, CheckCircle2, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { RoundPublishState } from "@/lib/skins-rounds";

/**
 * Where one Skins round stands. Shared by the referee's bracket and the
 * admin's approval queue so the two never describe the same round
 * differently.
 */
export function RoundStateBadge({ state }: { state: RoundPublishState }) {
  if (state === "published") {
    return (
      <Badge className="gap-1">
        <CheckCircle2 className="size-3.5" />
        Published
      </Badge>
    );
  }
  if (state === "draft") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Lock className="size-3.5" />
        Awaiting admin
      </Badge>
    );
  }
  if (state === "partial") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="size-3.5" />
        Partly published
      </Badge>
    );
  }
  return <Badge variant="outline">Not scored</Badge>;
}
