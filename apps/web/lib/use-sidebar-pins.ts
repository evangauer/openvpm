"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { TOOL_PATHS } from "./navigation";
import {
  parseSidebarPreferences,
  serializeSidebarPreferences,
  sidebarPinsKey,
  type SidebarLayout,
  type SidebarPreferences,
} from "./sidebar-pins";

const EMPTY = serializeSidebarPreferences({ layout: "full", pinned: [] });
const CHANGE = "openvpm:sidebar-pins";
// Only navigation paths, scoped to the signed-in user and clinic. No chart data.
const snapshots = new Map<string, string>();
const serverSnapshot = () => EMPTY;

function readStorage(key: string) {
  try {
    return serializeSidebarPreferences(
      parseSidebarPreferences(window.localStorage.getItem(key)),
    );
  } catch {
    return snapshots.get(key) ?? EMPTY;
  }
}

function snapshot(key: string | null) {
  if (!key || typeof window === "undefined") return EMPTY;
  if (!snapshots.has(key)) snapshots.set(key, readStorage(key));
  return snapshots.get(key)!;
}

export function useSidebarPins(practiceId?: string, userId?: string) {
  const key = practiceId && userId ? sidebarPinsKey(practiceId, userId) : null;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!key) return () => {};
      const storageChanged = (event: StorageEvent) => {
        if (event.key === key || event.key === null) {
          snapshots.set(key, readStorage(key));
          notify();
        }
      };
      const localChanged = (event: Event) => {
        if ((event as CustomEvent<string>).detail === key) notify();
      };
      window.addEventListener("storage", storageChanged);
      window.addEventListener(CHANGE, localChanged);
      return () => {
        window.removeEventListener("storage", storageChanged);
        window.removeEventListener(CHANGE, localChanged);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(() => snapshot(key), [key]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  const preferences = useMemo(() => parseSidebarPreferences(raw), [raw]);
  const updatePreferences = useCallback(
    (update: (previous: SidebarPreferences) => SidebarPreferences) => {
      if (!key) return;
      const next = serializeSidebarPreferences(
        update(parseSidebarPreferences(snapshot(key))),
      );
      snapshots.set(key, next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        toast.warning(
          "Sidebar updated for this session. Browser storage is unavailable.",
          { id: "sidebar-storage-unavailable" },
        );
      }
      window.dispatchEvent(new CustomEvent(CHANGE, { detail: key }));
    },
    [key],
  );
  const togglePin = useCallback(
    (href: string) => {
      if (!TOOL_PATHS.includes(href)) return;
      updatePreferences((previous) => ({
        ...previous,
        pinned: previous.pinned.includes(href)
          ? previous.pinned.filter((item) => item !== href)
          : [...previous.pinned, href],
      }));
    },
    [updatePreferences],
  );
  const setLayout = useCallback(
    (layout: SidebarLayout) => {
      updatePreferences((previous) => ({ ...previous, layout }));
    },
    [updatePreferences],
  );
  return { ...preferences, togglePin, setLayout };
}
