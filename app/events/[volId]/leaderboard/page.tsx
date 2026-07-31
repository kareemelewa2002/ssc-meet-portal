import { LeaderboardClient } from "@/components/events/leaderboard-client";

export default async function LeaderboardPage({
  params,
}: {
  params: Promise<{ volId: string }>;
}) {
  const { volId } = await params;
  return <LeaderboardClient volId={volId} />;
}
