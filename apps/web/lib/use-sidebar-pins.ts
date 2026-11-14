"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { trpc } from "./trpc";
import { parseSidebarPreferences, sidebarPinsKey, type SidebarLayout } from "./sidebar-pins";
import { EMPTY_SIDEBAR, SidebarSync } from "./sidebar-sync";

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
      read: () => client.sidebar.get.query(scope),
      write: command => client.sidebar.update.mutate({ ...scope, command }),
      save: value => window.localStorage.setItem(cacheKey, value),
      storageError: () => toast.warning("Sidebar updated for this session. Browser storage is unavailable.", { id: "sidebar-storage-unavailable" }),
      error: () => toast.warning("Sidebar choices are kept on this device. Account sync will retry when connected.", { id: "sidebar-sync-unavailable" }),
    });
  }, [practiceId, userId, client]);
  const raw = useSyncExternalStore(sync?.subscribe ?? noSubscription, sync?.snapshot ?? serverSnapshot, serverSnapshot);
  useEffect(() => {
    if (!sync) return;
    const refresh = () => { if (document.visibilityState !== "hidden") void sync.sync(); };
    refresh();
    const storageChanged = (event: StorageEvent) => {
      if (practiceId && userId && event.key === `${sidebarPinsKey(practiceId, userId)}.sync-v2`) refresh();
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
