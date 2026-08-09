"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MessageSquare, Check, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  MessagingWizard,
  type MessagingSetupLocation,
} from "@/components/settings/messaging-wizard";
import type { StepHandle } from "../journey-types";

/**
 * Optional step: text-enable a phone number so the clinic can send reminders and
 * two-way texts. Reuses the self-contained MessagingWizard (it layers above this
 * overlay), so nothing is lost — Continue always advances (this step is skippable).
 */
export function SetUpTextingStep({
  register,
}: {
  register: (h: StepHandle) => void;
}) {
  const status = trpc.messaging.getStatus.useQuery(undefined, { retry: false });
  const [wizardOpen, setWizardOpen] = useState(false);

  useEffect(() => {
    // Skippable: Continue never blocks.
    register({ onContinue: async () => true });
  }, [register]);

  // Prefer the primary location; fall back to the first one. Map into the exact
  // MessagingSetupLocation shape (getStatus adds a `provider` field the wizard
  // doesn't take).
  const location: MessagingSetupLocation | null = (() => {
    const locs = status.data?.locations ?? [];
    if (locs.length === 0) return null;
    const l = locs.find((loc) => loc.isPrimary) ?? locs[0]!;
    return {
      locationId: l.locationId,
      name: l.name,
      isPrimary: l.isPrimary,
      existingPhone: l.existingPhone,
      messaging: l.messaging
        ? {
            senderE164: l.messaging.senderE164,
            messagingProfileId: l.messaging.messagingProfileId,
            numberSource: l.messaging.numberSource,
            registrationStatus: l.messaging.registrationStatus ?? "not_started",
            registrationDetail: l.messaging.registrationDetail,
            enabled: l.messaging.enabled ?? false,
          }
        : null,
    };
  })();

  const messaging = location?.messaging ?? null;
  const hasSender = Boolean(
    messaging?.senderE164?.trim() && messaging?.messagingProfileId?.trim()
  );
  const isFailed = messaging?.registrationStatus === "failed";
  const isConfigured = hasSender && !isFailed;
  const isActive =
    messaging?.registrationStatus === "active" && !!messaging?.enabled;
  const statusDetail = (() => {
    if (!messaging) return null;
    if (isFailed) {
      return "Number setup did not finish. Reconcile the saved provider setup in Messaging settings; OpenVPM will not buy another number automatically.";
    }
    if (messaging.registrationStatus === "not_started" && hasSender) {
      return "Number order accepted. Carrier registration has not been submitted; complete the clinic details in Messaging settings.";
    }
    if (messaging.registrationStatus === "pending") {
      return "Carrier registration is under review. Sending remains off until approval.";
    }
    if (messaging.registrationStatus === "active" && !messaging.enabled) {
      return "Carrier registration is approved. An admin still needs to enable sending in Messaging settings.";
    }
    if (isActive) return "Texting is active.";
    if (messaging.registrationStatus === "action_required") {
      return "Carrier registration needs more clinic information. Review the request in Messaging settings.";
    }
    if (messaging.registrationStatus === "suspended") {
      return "Texting is suspended. Review Messaging settings and contact OpenVPM support.";
    }
    return "Texting is not ready yet. Review Messaging settings before sending.";
  })();

  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-slate-600">
        Text your clients about appointments, reminders, and results, and let them
        text you back. OpenVPM can set up a new local texting number; your existing
        clinic voice line stays unchanged. This is optional, so skip it and set it
        up later if you like.
      </p>

      <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
            <MessageSquare className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            {status.isLoading ? (
              <p className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking your texting setup…
              </p>
            ) : status.error ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-slate-900">
                  Unable to check texting setup
                </p>
                <p className="text-xs text-slate-500">
                  Retry this step before starting or changing setup.
                </p>
              </div>
            ) : messaging ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-slate-900">
                  {messaging.senderE164 ?? "Texting setup needs attention"}
                </p>
                <p className="text-xs text-slate-500">
                  {statusDetail}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-sm font-medium text-slate-900">
                  Texting is not set up yet
                </p>
                <p className="text-xs text-slate-500">
                  Set up a number for {location?.name ?? "your clinic"}.
                </p>
              </div>
            )}
          </div>
          {!status.isLoading && !status.error && location ? (
            messaging ? (
              <Button asChild type="button" variant="outline" size="sm">
                <Link href="/settings?tab=messaging">
                  {isConfigured ? <Check className="mr-1.5 h-4 w-4" /> : null}
                  Review
                </Link>
              </Button>
            ) : (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => setWizardOpen(true)}
            >
              Set up texting
            </Button>
            )
          ) : null}
        </div>
      </div>

      <MessagingWizard
        location={location}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onChanged={() => void status.refetch()}
      />
    </div>
  );
}
