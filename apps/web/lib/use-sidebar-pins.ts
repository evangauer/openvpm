"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { TOOL_PATHS } from "./navigation";
import {
  parseSidebarPins,
  serializeSidebarPins,
  sidebarPinsKey,
} from "./sidebar-pins";

const EMPTY = serializeSidebarPins([]);
const CHANGE = "openvpm:sidebar-pins";
// Only navigation paths, scoped to the signed-in user and clinic. No chart data.
const snapshots = new Map<string, string>();
const serverSnapshot = () => EMPTY;

function readStorage(key: string) {
  try {
    return serializeSidebarPins(
      parseSidebarPins(window.localStorage.getItem(key)),
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
  const pinned = useMemo(() => parseSidebarPins(raw), [raw]);
  const togglePin = useCallback(
    (href: string) => {
      if (!key || !TOOL_PATHS.includes(href)) return;
      const previous = parseSidebarPins(snapshot(key));
      const next = serializeSidebarPins(
        previous.includes(href)
          ? previous.filter((item) => item !== href)
          : [...previous, href],
      );
      snapshots.set(key, next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        toast.warning(
          "Pins updated for this session. Browser storage is unavailable.",
        );
      }
      window.dispatchEvent(new CustomEvent(CHANGE, { detail: key }));
    },
    [key],
  );
  return { pinned, togglePin };
}
