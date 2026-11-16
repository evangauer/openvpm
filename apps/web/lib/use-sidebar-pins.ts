"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "./trpc";
import { parseSidebarPreferences, sidebarPinsKey, type SidebarLayout } from "./sidebar-pins";
import { EMPTY_SIDEBAR, sidebarPendingStore, SidebarSync } from "./sidebar-sync";

const serverSnapshot = () => EMPTY_SIDEBAR;
const noSubscription = () => () => {};
function read(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function useSidebarPins(practiceId?: string, userId?: string) {
  const utils = trpc.useUtils();
  const client = utils.client;
  const sync = useMemo(() => {
    if (!practiceId || !userId || typeof window === "undefined") return null;
    const legacyKey = sidebarPinsKey(practiceId, userId);
    const cacheKey = `${legacyKey}.sync-v2`;
    const scope = { practiceId, userId };
    return new SidebarSync({
      legacy: read(legacyKey), cached: read(cacheKey),
      pending: sidebarPendingStore({
        getItem: key => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
        removeItem: key => window.localStorage.removeItem(key),
      }, cacheKey, async work => {
        // Coordinate only short storage changes, never a network request.
        if (!navigator.locks) throw new Error("Browser storage coordination unavailable");
        await navigator.locks.request(cacheKey, work);
      }),
      read: () => client.sidebar.get.query(scope),
      write: command => client.sidebar.update.mutate({ ...scope, command }),
      save: value => window.localStorage.setItem(cacheKey, value),
      storageError: () => toast.warning("Sidebar updated for this session. Browser storage is unavailable.", { id: "sidebar-storage-unavailable" }),
      error: () => toast.warning("Sidebar choices are kept on this device. Account sync will retry when connected.", { id: "sidebar-sync-unavailable" }),
      isRejected: error => error instanceof TRPCClientError && error.data?.code === "BAD_REQUEST",
      rejected: () => toast.warning("A queued sidebar pin is no longer available for your role. Your other choices will still sync.", { id: "sidebar-pin-unavailable" }),
    });
  }, [practiceId, userId, client]);
  const raw = useSyncExternalStore(sync?.subscribe ?? noSubscription, sync?.snapshot ?? serverSnapshot, serverSnapshot);
  useEffect(() => {
    if (!sync) return;
    const refresh = () => { if (document.visibilityState !== "hidden") void sync.sync(); };
    refresh();
    const storageChanged = (event: StorageEvent) => {
      if (practiceId && userId) {
        const cacheKey = `${sidebarPinsKey(practiceId, userId)}.sync-v2`;
        if (event.key === cacheKey || event.key?.startsWith(`${cacheKey}.pending.`)) refresh();
      }
    };
    window.addEventListener("storage", storageChanged);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", storageChanged);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [sync, practiceId, userId]);
  const preferences = useMemo(() => parseSidebarPreferences(raw), [raw]);
  const togglePin = useCallback((href: string) => {
    if (!sync) return;
    const current = parseSidebarPreferences(sync.snapshot());
    sync.edit({ kind: "pin", href, pinned: !current.pinned.includes(href) });
  }, [sync]);
  const setLayout = useCallback((layout: SidebarLayout) => sync?.edit({ kind: "layout", layout }), [sync]);
  return { ...preferences, togglePin, setLayout };
}
