import { describe, expect, it } from "vitest";
import { summarizeInboxSmsStatus } from "../inbox-status";

describe("summarizeInboxSmsStatus", () => {
  it("enables SMS compose when any location has an active enabled sender", () => {
    expect(
      summarizeInboxSmsStatus([
        {
          messaging: {
            senderE164: "+15555550100",
            messagingProfileId: null,
            registrationStatus: "active",
            enabled: true,
          },
        },
      ]),
    ).toMatchObject({
      kind: "ready",
      smsComposeEnabled: true,
      showBanner: false,
    });
  });

  it("enables SMS compose when an active enabled sender uses only a messaging profile", () => {
    expect(
      summarizeInboxSmsStatus([
        {
          messaging: {
            senderE164: null,
            messagingProfileId: " profile-1 ",
            registrationStatus: "active",
            enabled: true,
          },
        },
      ]),
    ).toMatchObject({
      kind: "ready",
      smsComposeEnabled: true,
      showBanner: false,
    });
  });

  it("does not mark whitespace-only sender values as ready", () => {
    expect(
      summarizeInboxSmsStatus([
        {
          messaging: {
            senderE164: "   ",
            messagingProfileId: "\n",
            registrationStatus: "active",
            enabled: true,
          },
        },
      ]),
    ).toMatchObject({
      kind: "action_required",
      smsComposeEnabled: false,
      showBanner: true,
      badge: { variant: "destructive" },
    });
  });

  it("does not enable hosted compose until the exact provider profile is attested", () => {
    expect(
      summarizeInboxSmsStatus([
        {
          messaging: {
            provider: "telnyx",
            senderE164: "+15555550100",
            messagingProfileId: "profile-1",
            registrationStatus: "active",
            enabled: true,
            launchEligible: true,
            providerProfileReady: false,
            providerProfileReadyRequired: true,
          },
        },
      ]),
    ).toMatchObject({
      kind: "action_required",
      smsComposeEnabled: false,
      showBanner: true,
    });
  });

  it("prompts setup when no location has messaging configured", () => {
    expect(summarizeInboxSmsStatus([{ messaging: null }])).toMatchObject({
      kind: "not_configured",
      smsComposeEnabled: false,
      showBanner: true,
      actionLabel: "Set up texting",
    });
  });

  it("shows pending registration instead of offering SMS compose", () => {
    expect(
      summarizeInboxSmsStatus([
        {
          messaging: {
            senderE164: "+15555550100",
            messagingProfileId: null,
            registrationStatus: "pending",
            enabled: false,
          },
        },
      ]),
    ).toMatchObject({
      kind: "pending",
      smsComposeEnabled: false,
      badge: { variant: "warning" },
    });
  });

  it("prioritizes provider action required over generic disabled state", () => {
    expect(
      summarizeInboxSmsStatus([
        {
          messaging: {
            senderE164: "+15555550100",
            messagingProfileId: null,
            registrationStatus: "failed",
            enabled: false,
          },
        },
      ]),
    ).toMatchObject({
      kind: "action_required",
      smsComposeEnabled: false,
      badge: { variant: "destructive" },
    });
  });
});
