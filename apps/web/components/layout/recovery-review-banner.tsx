"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";

export function RecoveryReviewBanner() {
  const status = trpc.migrationArchive.reviewStatus.useQuery(undefined, {
    staleTime: 60_000,
  });

  if (!status.data?.recoveryHold) return null;

  return (
    <aside
      aria-label="Protected data review mode"
      className="border-b border-amber-300/70 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/50 dark:text-amber-100 sm:px-6"
    >
      <div className="mx-auto flex max-w-7xl items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 text-sm">
          <p className="font-semibold">Protected data review mode is active</p>
          <p className="mt-0.5 leading-5 opacity-90">
            You can inspect imported history safely. Operational changes,
            automated activity, and external delivery remain paused.
          </p>
          <Link
            href="/migration-archive"
            className="mt-1 inline-flex min-h-8 items-center font-semibold underline underline-offset-4"
          >
            Continue the data review
          </Link>
        </div>
      </div>
    </aside>
  );
}
