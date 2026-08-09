import { describe, expect, it, vi } from "vitest";
import {
  guardedSoapNavigationDestination,
  runSoapSafeLeave,
  soapEditorNeedsLeaveGuard,
  type SoapNavigationClick,
} from "../soap-navigation";

const currentHref =
  "https://app.openvpm.com/records/new-soap/patient-1?appointmentId=visit-1";

function click(
  overrides: Partial<SoapNavigationClick> = {},
): SoapNavigationClick {
  return {
    href: "https://app.openvpm.com/records",
    currentHref,
    button: 0,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    download: false,
    ...overrides,
  };
}

describe("SOAP editor navigation classification", () => {
  it("returns an ordinary same-origin application destination", () => {
    expect(
      guardedSoapNavigationDestination(
        click({
          href: "https://app.openvpm.com/patients/one?tab=records#latest",
        }),
      ),
    ).toBe("/patients/one?tab=records#latest");
  });

  it.each([
    { button: 1 },
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { defaultPrevented: true },
    { download: true },
    { target: "_blank" },
  ])("ignores modified or special clicks: %o", (overrides) => {
    expect(guardedSoapNavigationDestination(click(overrides))).toBeNull();
  });

  it("ignores external destinations", () => {
    expect(
      guardedSoapNavigationDestination(
        click({ href: "https://example.com/records" }),
      ),
    ).toBeNull();
  });

  it("ignores hash-only and current-page destinations", () => {
    expect(
      guardedSoapNavigationDestination(click({ href: `${currentHref}#plan` })),
    ).toBeNull();
    expect(
      guardedSoapNavigationDestination(click({ href: currentHref })),
    ).toBeNull();
  });
});

describe("SOAP editor safe leave", () => {
  it("does not warn before the draft has initialized", () => {
    expect(
      soapEditorNeedsLeaveGuard({
        draftInitialized: false,
        finalizedElsewhere: false,
        localTextCopied: false,
        hasLocalText: false,
        conflict: false,
        savePending: false,
        dirty: true,
      }),
    ).toBe(false);
  });

  it("retains finalized local-text protection regardless of initialization", () => {
    expect(
      soapEditorNeedsLeaveGuard({
        draftInitialized: false,
        finalizedElsewhere: true,
        localTextCopied: false,
        hasLocalText: true,
        conflict: false,
        savePending: false,
        dirty: false,
      }),
    ).toBe(true);
  });

  it("does not navigate when save discovers finalization until text is copied", async () => {
    let finalizedElsewhere = false;
    let localTextCopied = false;
    const persistDraft = vi.fn(async () => {
      finalizedElsewhere = true;
      return { outcome: "already_finalized" };
    });
    const confirmFinalizedLocalTextLeave = vi.fn(() => false);
    const navigate = vi.fn();
    const run = () =>
      runSoapSafeLeave({
        readState: () => ({
          finalizedElsewhere,
          needsGuard: true,
          localTextCopied,
          hasLocalText: true,
        }),
        persistDraft,
        confirmFinalizedLocalTextLeave,
        confirmUnsavedLeave: () => false,
        navigate,
      });

    await expect(run()).resolves.toBe(false);
    expect(persistDraft).toHaveBeenCalledTimes(1);
    expect(confirmFinalizedLocalTextLeave).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();

    localTextCopied = true;
    await expect(run()).resolves.toBe(true);
    expect(persistDraft).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
