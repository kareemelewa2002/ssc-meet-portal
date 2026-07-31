"use client";

import { CallRoom } from "@/components/usher/call-room";

const DEMO_USHER = {
  fullName: "Sam Okonkwo",
  roleLabel: "Usher",
  profileImageUrl: null as string | null,
};

export default function UsherPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Call-room attendance</h1>
        <p className="text-sm text-muted-foreground">
          Touch-friendly Present / Absent check-in for Session heats. Referees see updates live.
        </p>
      </header>
      <CallRoom usher={DEMO_USHER} />
    </main>
  );
}
