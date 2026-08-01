"use client";

import { CallRoom } from "@/components/usher/call-room";
import { AppHeader } from "@/components/layout/app-header";
import { useCurrentUser } from "@/hooks/use-current-user";

export default function UsherPage() {
  const { user, loading } = useCurrentUser();

  const usher = {
    fullName: user?.fullName ?? "Usher",
    roleLabel: "Usher",
    profileImageUrl: user?.profileImageUrl ?? null,
  };

  return (
    <div className="min-h-screen">
      <AppHeader title="Call-Room Attendance" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Call-room attendance</h1>
          <p className="text-sm text-muted-foreground">
            Touch-friendly Present / Absent check-in for Session heats. Referees see updates live.
          </p>
        </header>
        {!loading && <CallRoom usher={usher} />}
      </main>
    </div>
  );
}
