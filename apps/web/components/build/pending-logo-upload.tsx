"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc";
import { dataUrlToFile } from "@/lib/build/logo";

/** Set by "Build your clinic" just before Stripe Checkout. */
const PENDING_LOGO_KEY = "openvpm_build_logo_pending";

/**
 * Finishes "Build your clinic" inside the workspace: the logo a clinic
 * uploaded before signup lives in this browser until the first visit with an
 * active trial, then goes through the regular logo upload. It never replaces
 * a logo the clinic already has, and tries again on a later visit if the
 * upload is refused (for example, before Stripe confirms the trial).
 */
export function PendingLogoUpload() {
  const { data: session, status } = useSession();
  const isAdmin = status === "authenticated" && session?.user?.role === "admin";
  const [pending, setPending] = useState<string | null>(null);
  const attempted = useRef(false);
  const utils = trpc.useUtils();

  useEffect(() => {
    try {
      setPending(window.localStorage.getItem(PENDING_LOGO_KEY));
    } catch {
      setPending(null);
    }
  }, []);

  const branding = trpc.settings.getBranding.useQuery(undefined, {
    enabled: isAdmin && Boolean(pending),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!isAdmin || !pending || attempted.current || !branding.data) return;
    attempted.current = true;
    const clear = () => {
      try {
        window.localStorage.removeItem(PENDING_LOGO_KEY);
      } catch {
        // Nothing else to do.
      }
    };
    if (branding.data.logoUrl) {
      clear();
      return;
    }
    const file = dataUrlToFile(pending, "logo.png");
    if (!file) {
      clear();
      return;
    }
    const body = new FormData();
    body.append("file", file);
    body.append("category", "branding");
    void fetch("/api/upload", {
      method: "POST",
      body,
      headers: { "Idempotency-Key": crypto.randomUUID() },
    })
      .then(async (response) => {
        if (!response.ok) return;
        clear();
        await utils.settings.getBranding.invalidate();
      })
      .catch(() => undefined);
  }, [isAdmin, pending, branding.data, utils]);

  return null;
}
