import Link from "next/link";

import { cn } from "@/lib/cn";

const TONES = {
  neutral: "text-neutral-900",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  error: "text-[var(--error)]",
} as const;

export function StatCard({
  label,
  value,
  context,
  icon,
  tone = "neutral",
  href,
}: {
  label: string;
  value: string;
  context?: string;
  icon?: React.ReactNode;
  tone?: keyof typeof TONES;
  href?: string;
}) {
  const body = (
    <div className="rounded-lg border border-border bg-surface p-4 transition-colors duration-fast hover:border-neutral-300">
      <div className="flex items-start justify-between gap-2">
        <p className="text-body-sm text-muted">{label}</p>
        {icon && <span className="text-neutral-400">{icon}</span>}
      </div>
      <p className={cn("tabular font-display mt-2 text-h2 font-bold", TONES[tone])}>{value}</p>
      {context && <p className="mt-1 text-caption text-muted">{context}</p>}
    </div>
  );

  return href ? (
    <Link href={href} className="block rounded-lg focus-visible:ring-4 focus-visible:ring-[var(--ring)]">
      {body}
    </Link>
  ) : (
    body
  );
}
