import { describe, expect, it } from "vitest";
import {
  canDetachUnsavedListeners,
  isSameDocumentHashNavigation,
  resolveUnsavedPopEffect,
  shouldReplaceGuardedHashNavigation,
} from "../use-unsaved-changes-guard";

describe("unsaved changes history guard", () => {
  it("starts sentinel cleanup only once while a save effect settles", () => {
    expect(
      canDetachUnsavedListeners({
        listenersAttached: true,
        activeGuardCount: 0,
        pendingAction: null,
      }),
    ).toBe(true);
    expect(
      canDetachUnsavedListeners({
        listenersAttached: true,
        activeGuardCount: 0,
        pendingAction: "cleanup",
      }),
    ).toBe(false);
  });

  it("uses the same-URL sentinel as the decision point", () => {
    expect(
      resolveUnsavedPopEffect({
        pendingAction: null,
        guardActive: true,
        sentinelActive: true,
        confirmed: false,
      }),
    ).toBe("go-forward");
    expect(
      resolveUnsavedPopEffect({
        pendingAction: null,
        guardActive: true,
        sentinelActive: true,
        confirmed: true,
      }),
    ).toBe("go-back");
  });

  it("restores, leaves, and cleans up through explicit follow-up states", () => {
    expect(
      resolveUnsavedPopEffect({
        pendingAction: "restore",
        guardActive: true,
        sentinelActive: false,
        confirmed: false,
      }),
    ).toBe("restore-sentinel");
    expect(
      resolveUnsavedPopEffect({
        pendingAction: "leave",
        guardActive: true,
        sentinelActive: false,
        confirmed: false,
      }),
    ).toBe("leave-page");
    expect(
      resolveUnsavedPopEffect({
        pendingAction: "cleanup",
        guardActive: false,
        sentinelActive: true,
        confirmed: false,
      }),
    ).toBe("cleanup");
    expect(
      resolveUnsavedPopEffect({
        pendingAction: "cleanup",
        guardActive: true,
        sentinelActive: true,
        confirmed: false,
      }),
    ).toBe("rearm-sentinel");
  });

  it("allows ordinary history when no dirty guard is active", () => {
    expect(
      resolveUnsavedPopEffect({
        pendingAction: null,
        guardActive: false,
        sentinelActive: false,
        confirmed: false,
      }),
    ).toBe("allow");
  });

  it("replaces the active sentinel for same-document hashes instead of pushing above it", () => {
    const current =
      "https://app.openvpm.com/encounters/visit-1?payment=success";
    expect(isSameDocumentHashNavigation("#visit-closeout", current)).toBe(true);
    expect(
      isSameDocumentHashNavigation(
        "https://app.openvpm.com/encounters/visit-2#visit-closeout",
        current,
      ),
    ).toBe(false);
    expect(isSameDocumentHashNavigation("/billing#invoice", current)).toBe(
      false,
    );
    expect(
      shouldReplaceGuardedHashNavigation({
        guardActive: true,
        sentinelActive: true,
        targetHref: "#visit-closeout",
        currentHref: current,
      }),
    ).toBe(true);
    expect(
      shouldReplaceGuardedHashNavigation({
        guardActive: true,
        sentinelActive: false,
        targetHref: "#visit-closeout",
        currentHref: current,
      }),
    ).toBe(false);
    expect(
      shouldReplaceGuardedHashNavigation({
        guardActive: false,
        sentinelActive: true,
        targetHref: "#visit-closeout",
        currentHref: current,
      }),
    ).toBe(false);
  });
});
