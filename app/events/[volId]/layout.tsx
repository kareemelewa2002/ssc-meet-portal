import { notFound } from "next/navigation";
import { BottomTabNav } from "@/components/layout/bottom-tab-nav";
import { AppHeader } from "@/components/layout/app-header";
import { createClient } from "@/lib/supabase/server";
import { slugifyVolumeName } from "@/lib/volumes";

/**
 * Gates every /events/[volId]/* route on the volume being announced.
 *
 * WHY THIS EXISTS
 * ---------------
 * /meets and /leaderboards already exclude status = 'planned', and
 * fetchActiveVolume() skips it — but those only control what is LISTED. The
 * volume-scoped routes look a volume up by number with no status check at all,
 * so anyone typing /events/2/register saw an unannounced meet's name, its
 * sessions and its prices. A volume being absent from the index is not the
 * same as it being private.
 *
 * Admins are exempt: they have to be able to open a planned volume to build
 * and price it before it goes public. Everyone else gets a 404 — not a
 * "coming soon" page, which would confirm the volume exists and leak its
 * number.
 *
 * This runs on the SERVER. A client-side redirect would still have shipped the
 * volume's name and schedule to the browser first.
 */
export default async function VolumeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ volId: string }>;
}) {
  const { volId } = await params;
  const supabase = await createClient();

  const { data: volumes, error } = await supabase
    .from("meet_volumes")
    .select("volume_number, name, status");

  // A failed lookup must not fall open. If we cannot tell whether this volume
  // is announced, we do not show it — the alternative is that a transient
  // Supabase error publishes an unannounced meet.
  if (error) notFound();

  const asNumber = Number(volId);
  const volume =
    (Number.isFinite(asNumber)
      ? volumes?.find((v) => v.volume_number === asNumber)
      : undefined) ??
    volumes?.find((v) => slugifyVolumeName(v.name) === volId.toLowerCase());

  if (!volume) notFound();

  if (volume.status === "planned") {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    let isAdmin = false;
    if (user) {
      const { data: profile } = await supabase
        .from("users")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      isAdmin = profile?.role === "admin";
    }

    if (!isAdmin) notFound();
  }

  return (
    <div className="min-h-screen pb-16 md:pb-0">
      <AppHeader />
      {children}
      <BottomTabNav volId={volId} />
    </div>
  );
}
