import { notFound } from "next/navigation";
import { BottomTabNav } from "@/components/layout/bottom-tab-nav";
import { AppHeader } from "@/components/layout/app-header";
import { createClient } from "@/lib/supabase/server";
import { fetchVolumeByNumber } from "@/lib/volumes";

/**
 * Gates every /events/[volId]/* route on the volume being publicly visible.
 *
 * WHY THIS EXISTS
 * ---------------
 * /meets and /leaderboards control what is LISTED, but the volume-scoped
 * routes look a volume up by number with no check of their own — so typing
 * /events/2/register rendered an unannounced meet's name, its sessions and
 * its prices to anyone signed in. Absent from an index is not the same as
 * private.
 *
 * WHERE THE ACTUAL GATE LIVES
 * ----------------------------
 * Not here. `public.meet_volumes`' RLS policy (public.is_admin() or
 * (is_public and status <> 'planned')) is the single enforced definition of
 * "who may see this volume" — schema.sql's volume_is_public() comment says so
 * explicitly. This layout does not re-derive that rule in TypeScript; it
 * queries the volume through fetchVolumeByNumber() and treats "RLS returned
 * nothing" the same as "does not exist": notFound(). Two copies of the same
 * visibility rule — one in SQL, one in this file — is exactly the kind of
 * drift this codebase's own commentary warns about elsewhere (the retired
 * 'coach' role, turnaround duplicated on two tables). There is one copy, and
 * it lives in the database.
 *
 * The server client is passed through deliberately: the browser client
 * cannot see this Server Component's session cookies, so calling it here
 * would authenticate as nobody and make every admin's own volumes disappear
 * for them too.
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

  const result = await fetchVolumeByNumber(volId, supabase);

  // A failed lookup must not fall open. If we cannot tell whether this volume
  // is visible, we do not show it — the alternative is a transient Supabase
  // error rendering an unannounced meet.
  if (result.error || !result.data) notFound();

  return (
    <div className="min-h-screen pb-16 md:pb-0">
      <AppHeader />
      {children}
      <BottomTabNav volId={volId} />
    </div>
  );
}
