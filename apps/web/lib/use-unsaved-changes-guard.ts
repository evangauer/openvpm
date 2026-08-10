"use client";

import { useEffect, useRef } from "react";

const activeGuards = new Map<symbol, string>();
const HISTORY_SENTINEL_KEY = "__openvpmUnsavedGuard";
let listenersAttached = false;
let originalPushState: History["pushState"] | null = null;
let sentinelActive = false;
let bypassBeforeUnload = false;
let pendingPopAction: "leave" | "restore" | "cleanup" | null = null;

export type UnsavedPopEffect =
  | "allow"
  | "cleanup"
  | "rearm-sentinel"
  | "restore-sentinel"
  | "leave-page"
  | "go-back"
  | "go-forward";

export function resolveUnsavedPopEffect(input: {
  pendingAction: "leave" | "restore" | "cleanup" | null;
  guardActive: boolean;
  sentinelActive: boolean;
  confirmed: boolean;
}): UnsavedPopEffect {
  if (input.pendingAction === "cleanup") {
    return input.guardActive ? "rearm-sentinel" : "cleanup";
  }
  if (input.pendingAction === "restore") return "restore-sentinel";
  if (input.pendingAction === "leave") return "leave-page";
  if (!input.guardActive || !input.sentinelActive) return "allow";
  return input.confirmed ? "go-back" : "go-forward";
}

export function isSameDocumentHashNavigation(
  targetHref: string,
  currentHref: string,
): boolean {
  const target = new URL(targetHref, currentHref);
  const current = new URL(currentHref);
  return (
    Boolean(target.hash) &&
    target.origin === current.origin &&
    target.pathname === current.pathname &&
    target.search === current.search
  );
}

export function shouldReplaceGuardedHashNavigation(input: {
  guardActive: boolean;
  sentinelActive: boolean;
  targetHref: string;
  currentHref: string;
}): boolean {
  return (
    input.guardActive &&
    input.sentinelActive &&
    isSameDocumentHashNavigation(input.targetHref, input.currentHref)
  );
}

function replaceSentinelHash(targetHref: string) {
  const oldUrl = window.location.href;
  const target = new URL(targetHref, oldUrl);
  const currentState =
    window.history.state && typeof window.history.state === "object"
      ? window.history.state
      : {};

  // Keep the sentinel as the current history entry. A native hash navigation
  // would push a new entry above it, causing the first confirmed Back to land
  // on the underlying encounter instead of actually leaving the page.
  window.history.replaceState(
    { ...currentState, [HISTORY_SENTINEL_KEY]: true },
    "",
    target.href,
  );

  const rawTargetId = target.hash.slice(1);
  if (rawTargetId) {
    const targetId = decodeURIComponent(rawTargetId);
    const destination =
      document.getElementById(targetId) ??
      document.getElementsByName(targetId).item(0);
    destination?.scrollIntoView();
  }

  window.dispatchEvent(
    new HashChangeEvent("hashchange", {
      oldURL: oldUrl,
      newURL: target.href,
    }),
  );
}

function activeMessage(): string {
  return (
    activeGuards.values().next().value ??
    "This page has changes that are not saved on the server. Leave and lose those changes?"
  );
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (activeGuards.size === 0 || bypassBeforeUnload) return;
  event.preventDefault();
  event.returnValue = "";
}

function handleDocumentClick(event: MouseEvent) {
  if (activeGuards.size === 0) return;
  const target = event.target;
  const anchor =
    target instanceof Element
      ? target.closest<HTMLAnchorElement>("a[href]")
      : null;
  if (
    !anchor ||
    anchor.target === "_blank" ||
    anchor.hasAttribute("download") ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  if (
    shouldReplaceGuardedHashNavigation({
      guardActive: activeGuards.size > 0,
      sentinelActive,
      targetHref: anchor.href,
      currentHref: window.location.href,
    })
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    replaceSentinelHash(anchor.href);
    return;
  }
  if (window.confirm(activeMessage())) {
    event.preventDefault();
    event.stopImmediatePropagation();
    bypassBeforeUnload = true;
    window.location.assign(anchor.href);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

function handlePopState(event: PopStateEvent) {
  const needsDecision =
    pendingPopAction === null && activeGuards.size > 0 && sentinelActive;
  const effect = resolveUnsavedPopEffect({
    pendingAction: pendingPopAction,
    guardActive: activeGuards.size > 0,
    sentinelActive,
    confirmed: needsDecision ? window.confirm(activeMessage()) : false,
  });
  if (effect === "cleanup") {
    pendingPopAction = null;
    sentinelActive = false;
    event.stopImmediatePropagation();
    removeListeners();
    return;
  }
  if (effect === "rearm-sentinel") {
    pendingPopAction = null;
    sentinelActive = false;
    event.stopImmediatePropagation();
    pushSentinel();
    return;
  }
  if (effect === "restore-sentinel") {
    pendingPopAction = null;
    sentinelActive = true;
    event.stopImmediatePropagation();
    return;
  }
  if (effect === "leave-page") {
    pendingPopAction = null;
    sentinelActive = false;
    bypassBeforeUnload = true;
    return;
  }
  if (effect === "allow") return;

  // The sentinel duplicates the current Next.js history entry. The first Back
  // therefore stays on the same URL and gives us a safe decision point before
  // a second Back can leave the page.
  sentinelActive = false;
  event.stopImmediatePropagation();
  if (effect === "go-back") {
    pendingPopAction = "leave";
    window.history.back();
  } else {
    pendingPopAction = "restore";
    window.history.forward();
  }
}

function removeListeners() {
  if (!listenersAttached) return;
  window.removeEventListener("beforeunload", handleBeforeUnload);
  window.removeEventListener("popstate", handlePopState, true);
  document.removeEventListener("click", handleDocumentClick, true);
  originalPushState = null;
  bypassBeforeUnload = false;
  listenersAttached = false;
}

function pushSentinel() {
  if (!originalPushState) return;
  const currentState =
    window.history.state && typeof window.history.state === "object"
      ? window.history.state
      : {};
  originalPushState.call(
    window.history,
    { ...currentState, [HISTORY_SENTINEL_KEY]: true },
    "",
    window.location.href,
  );
  sentinelActive = true;
}

function attachListeners() {
  if (listenersAttached || typeof window === "undefined") return;
  originalPushState = window.history.pushState;
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("popstate", handlePopState, true);
  document.addEventListener("click", handleDocumentClick, true);
  listenersAttached = true;
  pushSentinel();
}

function detachListenersIfIdle() {
  if (!listenersAttached || activeGuards.size > 0) return;
  if (sentinelActive) {
    pendingPopAction = "cleanup";
    window.history.back();
    return;
  }
  removeListeners();
}

/**
 * Guards browser and anchor navigation while server-unacknowledged form state
 * exists. Only an in-memory boolean and static warning are tracked; form data
 * is never copied into browser storage.
 */
export function useUnsavedChangesGuard(dirty: boolean, message?: string) {
  const tokenRef = useRef(Symbol("unsaved-change-guard"));

  useEffect(() => {
    const token = tokenRef.current;
    if (!dirty) {
      activeGuards.delete(token);
      detachListenersIfIdle();
      return;
    }
    activeGuards.set(
      token,
      message ??
        "This page has changes that are not saved on the server. Leave and lose those changes?",
    );
    attachListeners();
    return () => {
      activeGuards.delete(token);
      detachListenersIfIdle();
    };
  }, [dirty, message]);
}
