import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { EntryStatus } from "@/lib/supabase/types";

/**
 * One vocabulary for "has this been paid?", used by the athlete, parent and
 * captain surfaces so the same state never reads as two different things.
 *
 * The colours are the project's own semantic tokens rather than ad-hoc
 * greens and yellows — note in particular that `pending` uses neon-orange,
 * which app/globals.css defines as "cash owed / attention, NOT failure".
 * That distinction matters here: money still owed at the desk is the normal,
 * expected state for most of a meet, and painting it red would have every
 * swimmer's dashboard screaming at them for doing nothing wrong. Red is
 * reserved for `unpaid`, which in this schema means a hold actually lapsed
 * and the slot was released.
 */
export type PaymentState = "paid" | "pending" | "unpaid";

const STYLES: Record<PaymentState, string> = {
  paid: "border-neon-lime/60 bg-neon-lime/15 text-neon-lime",
  pending: "border-neon-orange/60 bg-neon-orange/15 text-neon-orange",
  unpaid: "border-destructive/60 bg-destructive/15 text-destructive",
};

export function PaymentStatusBadge({
  state,
  label,
  className,
}: {
  state: PaymentState;
  label: string;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn(STYLES[state], className)}>
      {label}
    </Badge>
  );
}

/**
 * An entry's or relay squad's payment state, from its own status column.
 *
 * `confirmed` IS the paid state: an admin confirming a cash collection is
 * exactly what flips entries to confirmed (and seeds their heats), so there
 * is no separate per-entry paid flag to consult. entry_payments is one row
 * per (athlete, volume) — it settles a whole package at once and cannot say
 * which individual race was paid for.
 */
export function paymentStateForEntry(status: EntryStatus): {
  state: PaymentState;
  label: string;
} {
  switch (status) {
    case "confirmed":
      return { state: "paid", label: "Paid" };
    case "hold_expired":
      return { state: "unpaid", label: "Unpaid — slot released" };
    default:
      return { state: "pending", label: "Pending — cash at desk" };
  }
}
