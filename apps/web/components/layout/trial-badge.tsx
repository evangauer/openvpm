"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { Clock, ShieldAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Trial countdown / read-only indicator in the TopBar. Admin-only and hidden on
 * self-host (billing not enforced) or once a paid subscription is active.
 */
export function TrialBadge() {
  const { data: session, status } = useSession();
  const isAdmin =
    status === "authenticated" && session?.user?.role === "admin";

  const { data } = trpc.subscription.get.useQuery(undefined, {
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!data || !data.billingEnforced || data.billingStatus === "active") {
    return null;
  }

  const trialing = data.billingStatus === "trialing" && data.trialEndsAt;
  if (trialing) {
    const ms = new Date(data.trialEndsAt!).getTime() - Date.now();
    const days = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    // Progressive urgency: calm teal with plenty of runway, amber as it winds
    // down, red in the final stretch. The CTA shifts from a neutral "Subscribe"
    // to the more motivating "Keep your data" once the clock matters.
    const tone = days <= 2 ? "red" : days <= 5 ? "amber" : "teal";
    const toneClass = {
      teal: "border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100",
      amber: "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100",
      red: "border-red-200 bg-red-50 text-red-800 hover:bg-red-100",
    }[tone];
    const label =
      days === 0
        ? "Trial ends today"
        : `${days} day${days === 1 ? "" : "s"} left in trial`;
    return (
      <Link
        href="/settings?tab=billing"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
          toneClass
        )}
      >
        <Clock className="h-3.5 w-3.5" />
        {label}
        <span className="font-semibold">
          · {tone === "teal" ? "Subscribe" : "Keep your data"}
        </span>
      </Link>
    );
  }

  // Billing enforced, not trialing, no full access → lapsed / read-only.
  if (!data.hasFullAccess) {
    return (
      <Link
        href="/settings?tab=billing"
        className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
      >
        <ShieldAlert className="h-3.5 w-3.5" />
        Trial ended — read-only · Reactivate
      </Link>
    );
  }

  return null;
}
