"use client";

import { useSyncExternalStore } from "react";

export interface OnlineStatusEventTarget {
  addEventListener(type: "online" | "offline", listener: EventListener): void;
  removeEventListener(
    type: "online" | "offline",
    listener: EventListener,
  ): void;
}

/**
 * Subscribe to browser connectivity changes without retaining any application
 * data. Exported separately so event cleanup can be verified without a DOM.
 */
export function subscribeToOnlineStatus(
  onStoreChange: () => void,
  target: OnlineStatusEventTarget | null = typeof window === "undefined"
    ? null
    : window,
): () => void {
  if (!target) return () => undefined;

  const handleStatusChange: EventListener = () => onStoreChange();
  target.addEventListener("online", handleStatusChange);
  target.addEventListener("offline", handleStatusChange);
  return () => {
    target.removeEventListener("online", handleStatusChange);
    target.removeEventListener("offline", handleStatusChange);
  };
}

export function readOnlineStatus(
  source: Pick<Navigator, "onLine"> | null = typeof navigator === "undefined"
    ? null
    : navigator,
): boolean {
  return source?.onLine ?? true;
}

function readServerOnlineStatus(): boolean {
  return true;
}

/** Browser-reported connectivity. This is a signal for safe retry, not proof. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribeToOnlineStatus,
    readOnlineStatus,
    readServerOnlineStatus,
  );
}
