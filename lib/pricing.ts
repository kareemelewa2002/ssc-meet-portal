import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import {
  PRICING_TIER_LABELS,
  PRICING_TIERS,
  type MeetSettings,
  type PricingTier,
} from "@/lib/meet-settings";
import type { ScheduledEvent } from "@/lib/meet-settings";

// ---------------------------------------------------------------------------
// Pricing.
//
//   total = package(n individual races, tier)
//         + one additional-race price for each race beyond the 4th
//         + each entered race's own surcharge
//         + one relay fee per relay leg
//
// Race count is taken across the WHOLE volume: three races spread over two
// sessions is one three-race package, not two packages.
//
// TWO RULES THAT SHAPE EVERYTHING HERE
//
// 1. The price is settled at PAYMENT time, not registration time. Nothing is
//    snapshotted onto an entry. An athlete who registers during Early Bird and
//    pays after the boundary pays Standard — which is why every quote carries
//    its tier and that tier's end date, and why the registration UI has to say
//    so out loud. Discovering it at the desk would be indefensible.
//
// 2. A quote is LINE ITEMS, not a total. Every screen that asks an athlete for
//    money shows which race cost what. A function returning a bare number gets
//    re-derived differently by each caller, and then the desk and the
//    registration page disagree in front of a swimmer.
// ---------------------------------------------------------------------------

export type PriceLineKind = "package" | "additional_race" | "surcharge" | "relay";

export interface PriceLine {
  kind: PriceLineKind;
  label: string;
  entryId: string | null;
  amountEgp: number;
  tier: PricingTier;
}

export interface PriceQuote {
  lines: PriceLine[];
  totalEgp: number;
  tier: PricingTier;
  /** How many individual races the package was counted from. */
  raceCount: number;
}

export interface PricingMatrixCell {
  raceCount: number;
  tier: PricingTier;
  priceEgp: number;
}

export interface TierWindow {
  tier: PricingTier;
  startsAt: string;
  endsAt: string;
}

/** race_count 0 is the "each additional race" price, not a zero-race package. */
export const ADDITIONAL_RACE_ROW = 0;

export const PACKAGE_RACE_COUNTS: readonly number[] = [1, 2, 3, 4];

export function priceLineKindLabel(kind: PriceLineKind): string {
  switch (kind) {
    case "package":
      return "Package";
    case "additional_race":
      return "Additional race";
    case "surcharge":
      return "Race surcharge";
    case "relay":
      return "Relay leg";
  }
}

// ---------------------------------------------------------------------------
// Pure arithmetic — the same formula the SQL uses, for the registration form
// to price a selection that has not been saved as entries yet.
//
// This duplication is deliberate and narrow. A swimmer ticking boxes has no
// rows in public.entries to quote from, and round-tripping the database on
// every checkbox would be both slow and wrong (it would price races they have
// not committed to). quoteSelection() and public.quote_athlete_entries() must
// therefore agree, and lib/__tests__/pricing.test.ts pins the shape.
// ---------------------------------------------------------------------------

export function activeTier(
  settings: Pick<MeetSettings, "pinnedPricingTier">,
  windows: TierWindow[],
  now: Date = new Date(),
): PricingTier {
  // An admin pin outranks the calendar — that is the entire point of a pin.
  if (settings.pinnedPricingTier) return settings.pinnedPricingTier;

  const containing = windows.find(
    (w) => now >= new Date(w.startsAt) && now < new Date(w.endsAt),
  );
  if (containing) return containing.tier;

  // Before the first window opens, quote the earliest tier: a meet that has
  // not started selling should read Early Bird, not nothing.
  const upcoming = windows
    .filter((w) => new Date(w.startsAt) > now)
    .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))[0];
  if (upcoming) return upcoming.tier;

  // After the last window closes, quote the latest. Whether registration is
  // still open is a different question, answered by the registration window —
  // but whatever does get sold must never sell at Early Bird.
  const last = [...windows].sort((a, b) => +new Date(b.endsAt) - +new Date(a.endsAt))[0];
  return last?.tier ?? "standard";
}

/** When the tier in force stops applying — what the athlete must be told. */
export function tierEndsAt(tier: PricingTier, windows: TierWindow[]): Date | null {
  const window = windows.find((w) => w.tier === tier);
  return window ? new Date(window.endsAt) : null;
}

function packagePrice(matrix: PricingMatrixCell[], raceCount: number, tier: PricingTier): number {
  const cell = matrix.find((c) => c.raceCount === raceCount && c.tier === tier);
  return cell?.priceEgp ?? 0;
}

/**
 * Prices a set of races the athlete has SELECTED but not yet entered.
 *
 * `relayLegCount` is passed separately because a relay leg is charged on top
 * and never counted toward the individual package.
 */
export function quoteSelection(input: {
  events: Pick<ScheduledEvent, "id" | "name" | "surchargeEgp" | "isRelay">[];
  matrix: PricingMatrixCell[];
  tier: PricingTier;
  relaySwimmerPriceEgp: number;
  relayLegCount?: number;
}): PriceQuote {
  const { matrix, tier, relaySwimmerPriceEgp } = input;
  const individual = input.events.filter((e) => !e.isRelay);
  const raceCount = individual.length;
  const lines: PriceLine[] = [];

  if (raceCount > 0) {
    const bundled = Math.min(raceCount, 4);
    lines.push({
      kind: "package",
      label:
        raceCount > 4
          ? `${raceCount}-race entry (4-race package + ${raceCount - 4} extra)`
          : `${raceCount}-race package`,
      entryId: null,
      amountEgp: packagePrice(matrix, bundled, tier),
      tier,
    });

    // Races past the fourth, one line each so the athlete can see them.
    const extraPrice = packagePrice(matrix, ADDITIONAL_RACE_ROW, tier);
    individual.slice(4).forEach((event) => {
      lines.push({
        kind: "additional_race",
        label: `Additional race — ${event.name}`,
        entryId: event.id,
        amountEgp: extraPrice,
        tier,
      });
    });
  }

  // Zero-surcharge races are omitted rather than listed as "+0": a breakdown
  // of forty lines that are mostly zero explains nothing.
  individual
    .filter((e) => e.surchargeEgp > 0)
    .forEach((event) => {
      lines.push({
        kind: "surcharge",
        label: `${event.name} surcharge`,
        entryId: event.id,
        amountEgp: event.surchargeEgp,
        tier,
      });
    });

  for (let i = 0; i < (input.relayLegCount ?? 0); i += 1) {
    lines.push({
      kind: "relay",
      label: "Relay leg",
      entryId: null,
      amountEgp: relaySwimmerPriceEgp,
      tier,
    });
  }

  return {
    lines,
    totalEgp: lines.reduce((sum, l) => sum + l.amountEgp, 0),
    tier,
    raceCount,
  };
}

/**
 * What one more race would add, at today's tier.
 *
 * Not simply the next package minus this one: past the fourth race the answer
 * is the additional-race price, and after payment the answer is always the
 * 1-race package price (the agreed rule for adding a race post-payment).
 */
export function marginalRacePriceEgp(input: {
  matrix: PricingMatrixCell[];
  tier: PricingTier;
  currentRaceCount: number;
  surchargeEgp?: number;
  alreadyPaid?: boolean;
}): number {
  const { matrix, tier, currentRaceCount } = input;
  const surcharge = input.surchargeEgp ?? 0;

  // Already paid: the original package stands and the added race is its own
  // line at the 1-race price.
  if (input.alreadyPaid) {
    return packagePrice(matrix, 1, tier) + surcharge;
  }

  if (currentRaceCount >= 4) {
    return packagePrice(matrix, ADDITIONAL_RACE_ROW, tier) + surcharge;
  }

  const before = currentRaceCount === 0 ? 0 : packagePrice(matrix, currentRaceCount, tier);
  const after = packagePrice(matrix, currentRaceCount + 1, tier);
  return after - before + surcharge;
}

export function formatEgp(amount: number): string {
  return `${amount.toLocaleString("en-US")} EGP`;
}

export function tierLabel(tier: PricingTier): string {
  return PRICING_TIER_LABELS[tier];
}

// ---------------------------------------------------------------------------
// Data access.
// ---------------------------------------------------------------------------

export async function fetchPricingMatrix(
  meetVolumeId: string,
): Promise<FetchResult<PricingMatrixCell[]>> {
  const result = await runQuery<
    { race_count: number; tier: PricingTier; price_egp: number }[]
  >(
    "Loading pricing matrix",
    async () => {
      const supabase = createClient();
      return supabase
        .from("pricing_packages")
        .select("race_count, tier, price_egp")
        .eq("meet_volume_id", meetVolumeId)
        .order("race_count", { ascending: true });
    },
    { empty: [] },
  );

  return {
    ...result,
    data: result.data.map((r) => ({
      raceCount: r.race_count,
      tier: r.tier,
      priceEgp: r.price_egp,
    })),
  };
}

export async function fetchTierWindows(
  meetVolumeId: string,
): Promise<FetchResult<TierWindow[]>> {
  const result = await runQuery<{ tier: PricingTier; starts_at: string; ends_at: string }[]>(
    "Loading pricing tiers",
    async () => {
      const supabase = createClient();
      return supabase
        .from("pricing_tiers")
        .select("tier, starts_at, ends_at")
        .eq("meet_volume_id", meetVolumeId);
    },
    { empty: [] },
  );

  return {
    ...result,
    data: PRICING_TIERS.map((tier) => {
      const row = result.data.find((r) => r.tier === tier);
      return row
        ? { tier, startsAt: row.starts_at, endsAt: row.ends_at }
        : { tier, startsAt: "", endsAt: "" };
    }).filter((w) => w.startsAt !== ""),
  };
}

/**
 * The authoritative quote for entries that already exist, straight from
 * public.quote_athlete_entries().
 *
 * The cash desk uses this rather than quoteSelection(): at the desk the
 * entries are real rows, and the figure being collected must come from the
 * database rather than from a client that could be running yesterday's code.
 */
export async function fetchEntryQuote(
  athleteId: string,
  meetVolumeId: string,
  statuses: string[] = ["pending_payment"],
): Promise<FetchResult<PriceQuote | null>> {
  const result = await runQuery<
    { kind: PriceLineKind; label: string; entry_id: string | null; amount_egp: number; tier: PricingTier }[]
  >(
    "Pricing entries",
    async () => {
      const supabase = createClient();
      return supabase.rpc("quote_athlete_entries", {
        p_athlete_id: athleteId,
        p_meet_volume_id: meetVolumeId,
        p_include_statuses: statuses,
      });
    },
    { empty: [] },
  );

  if (result.error) return { ...result, data: null };

  const lines: PriceLine[] = result.data.map((r) => ({
    kind: r.kind,
    label: r.label,
    entryId: r.entry_id,
    amountEgp: r.amount_egp,
    tier: r.tier,
  }));

  if (lines.length === 0) {
    return { ...result, data: null };
  }

  const packageLine = lines.find((l) => l.kind === "package");
  const raceCount =
    lines.filter((l) => l.kind === "surcharge").length +
    (packageLine ? Number(/^(\d+)-race/.exec(packageLine.label)?.[1] ?? 0) : 0);

  return {
    ...result,
    data: {
      lines,
      totalEgp: lines.reduce((sum, l) => sum + l.amountEgp, 0),
      tier: lines[0].tier,
      raceCount,
    },
  };
}

export async function savePricingMatrix(
  meetVolumeId: string,
  cells: PricingMatrixCell[],
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("pricing_packages").upsert(
    cells.map((c) => ({
      meet_volume_id: meetVolumeId,
      race_count: c.raceCount,
      tier: c.tier,
      price_egp: c.priceEgp,
    })),
    { onConflict: "meet_volume_id,race_count,tier" },
  );
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function saveTierWindows(
  meetVolumeId: string,
  windows: TierWindow[],
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("pricing_tiers").upsert(
    windows.map((w) => ({
      meet_volume_id: meetVolumeId,
      tier: w.tier,
      starts_at: w.startsAt,
      ends_at: w.endsAt,
    })),
    { onConflict: "meet_volume_id,tier" },
  );
  if (error) return { success: false, error: error.message };
  return { success: true };
}
