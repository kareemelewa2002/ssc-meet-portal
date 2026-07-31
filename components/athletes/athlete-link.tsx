import Link from "next/link";
import { cn } from "@/lib/utils";

export function AthleteLink({
  athleteId,
  name,
  className,
}: {
  athleteId: string;
  name: string;
  className?: string;
}) {
  if (!athleteId) {
    return <span className={className}>{name}</span>;
  }

  return (
    <Link
      href={`/athletes/${athleteId}`}
      className={cn(
        "font-medium underline-offset-2 transition-colors hover:underline focus-visible:underline",
        className,
      )}
    >
      {name}
    </Link>
  );
}
