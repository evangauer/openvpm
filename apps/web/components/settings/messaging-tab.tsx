"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Loader2,
  MessageSquare,
  Phone,
  Send,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MessagingWizard,
  type MessagingSetupLocation,
} from "@/components/settings/messaging-wizard";
import {
  isMessagingPhoneInputValid,
  MESSAGING_PHONE_MAX_LENGTH,
} from "@/lib/messaging/policy";
import { toast } from "sonner";
import { MessagingRegistrationForm } from "@/components/settings/messaging-registration-form";

const REGISTRATION_BADGE: Record<
  NonNullable<MessagingSetupLocation["messaging"]>["registrationStatus"],
  { label: string; variant: "success" | "warning" | "destructive" | "secondary" }
> = {
  not_started: { label: "Not started", variant: "secondary" },
  pending: { label: "Registration pending", variant: "warning" },
  active: { label: "Active", variant: "success" },
  action_required: { label: "Action required", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  suspended: { label: "Suspended", variant: "destructive" },
};

const EMPTY_MESSAGING_LOCATIONS: MessagingSetupLocation[] = [];

function hasConfiguredSender(
  messaging: NonNullable<MessagingSetupLocation["messaging"]>
) {
  return Boolean(
    messaging.senderE164?.trim() || messaging.messagingProfileId?.trim()
  );
}

export function MessagingTab() {
  const searchParams = useSearchParams();
  const { data, isLoading, error, refetch } =
    trpc.messaging.getStatus.useQuery();
  const utils = trpc.useUtils();
  const [wizardLocation, setWizardLocation] =
    useState<MessagingSetupLocation | null>(null);
  const openedSetupParam = useRef(false);

  const statusLocations = data?.locations as
    | MessagingSetupLocation[]
    | undefined;
  const setupLocations = statusLocations ?? EMPTY_MESSAGING_LOCATIONS;

  useEffect(() => {
    if (openedSetupParam.current) return;
    if (searchParams.get("setup") !== "texting") return;
    const loc = setupLocations.find((l) => !l.messaging) ?? setupLocations[0];
    if (!loc) return;
    openedSetupParam.current = true;
    setWizardLocation(loc);
  }, [setupLocations, searchParams]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <MessagingLoadError
        message={error.message}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!data) {
    return (
      <MessagingLoadError
        message="Messaging status is unavailable. Retry before changing texting setup."
        onRetry={() => void refetch()}
      />
    );
  }

  const locations = data.locations as MessagingSetupLocation[];
  const usage = data.usage;
  const consent = data.consent;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <MessageSquare className="h-5 w-5" /> Messaging
        </h2>
        <p className="text-sm text-muted-foreground">
          Text appointment reminders from each location&apos;s own number. Clients
          who reply land in your inbox; STOP opt-outs are handled automatically.
        </p>
      </div>

      {/* Usage + consent summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryStat
          label="SMS this month"
          value={
            usage
              ? usage.includedSms != null
                ? `${usage.smsUsed} / ${usage.includedSms.toLocaleString()}`
                : String(usage.smsUsed)
              : "—"
          }
          hint={usage?.includedSms != null ? "included" : undefined}
        />
        <SummaryStat label="Clients opted in" value={String(consent?.optedIn ?? 0)} />
        <SummaryStat label="Opted out (STOP)" value={String(consent?.suppressed ?? 0)} />
      </div>

      {/* Per-location setup */}
      <div className="space-y-4">
        {locations.map((loc) => (
          <LocationCard
            key={loc.locationId}
            loc={loc}
            onStartSetup={() => setWizardLocation(loc)}
          />
        ))}
        {locations.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
            Add a location in Practice Info to set up texting.
          </p>
        )}
      </div>

      <MessagingRegistrationForm />

      <MessagingWizard
        location={wizardLocation}
        open={Boolean(wizardLocation)}
        onOpenChange={(open) => {
          if (!open) setWizardLocation(null);
        }}
        onChanged={() => utils.messaging.getStatus.invalidate()}
      />
    </div>
  );
}

function MessagingLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">Unable to load messaging settings</p>
          <p className="mt-1">{message}</p>
          <Button variant="outline" size="sm" onClick={onRetry} className="mt-3">
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">
        {value}
        {hint && <span className="ml-1 text-xs font-normal text-muted-foreground">{hint}</span>}
      </p>
    </div>
  );
}

function LocationCard({
  loc,
  onStartSetup,
}: {
  loc: MessagingSetupLocation;
  onStartSetup: () => void;
}) {
  const utils = trpc.useUtils();
  const refresh = () => utils.messaging.getStatus.invalidate();

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">{loc.name}</span>
          {loc.isPrimary && <Badge variant="secondary">Primary</Badge>}
        </div>
        {loc.messaging && (
          <Badge variant={REGISTRATION_BADGE[loc.messaging.registrationStatus].variant}>
            {REGISTRATION_BADGE[loc.messaging.registrationStatus].label}
          </Badge>
        )}
      </div>

      {loc.messaging ? (
        <ConfiguredLocation
          loc={loc}
          onChanged={refresh}
        />
      ) : (
        <UnconfiguredLocation loc={loc} onStartSetup={onStartSetup} />
      )}
    </div>
  );
}

function ConfiguredLocation({
  loc,
  onChanged,
}: {
  loc: MessagingSetupLocation;
  onChanged: () => void;
}) {
  const m = loc.messaging!;
  const [testTo, setTestTo] = useState("");
  const senderLabel =
    m.senderE164?.trim() || m.messagingProfileId?.trim() || "—";
  const canEnableSending =
    m.registrationStatus === "active" && hasConfiguredSender(m);
  const canSendTest =
    m.enabled && canEnableSending && isMessagingPhoneInputValid(testTo);

  const setEnabled = trpc.messaging.setEnabled.useMutation({
    onSuccess: () => onChanged(),
    onError: (e) => toast.error(e.message),
  });
  const testSend = trpc.messaging.testSend.useMutation({
    onSuccess: () => toast.success("Test message sent"),
    onError: (e) => toast.error(e.message),
  });
  const reconcileSetup = trpc.messaging.provisionNumber.useMutation({
    onSuccess: () => {
      toast.success("Provider setup reconciled. No additional number was purchased.");
      onChanged();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Phone className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{senderLabel}</span>
        {m.numberSource && (
          <Badge variant="outline">
            {m.numberSource === "hosted"
              ? "Your existing number"
              : m.numberSource === "purchased"
                ? "New local number"
                : "Toll-free"}
          </Badge>
        )}
      </div>

      {m.registrationDetail && m.registrationStatus !== "active" && (
        <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          {m.registrationDetail}
        </p>
      )}

      {m.registrationStatus === "failed" && !m.enabled ? (
        <Button
          variant="outline"
          disabled={reconcileSetup.isPending}
          onClick={() =>
            reconcileSetup.mutate({
              locationId: loc.locationId,
              mode: "buy",
              action: "resume",
            })
          }
        >
          {reconcileSetup.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          Reconcile provider setup
        </Button>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={m.enabled}
          disabled={setEnabled.isPending || (!m.enabled && !canEnableSending)}
          onChange={(e) =>
            setEnabled.mutate({ locationId: loc.locationId, enabled: e.target.checked })
          }
        />
        Sending enabled
      </label>

      <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Send a test message to
          </span>
          <Input
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            maxLength={MESSAGING_PHONE_MAX_LENGTH}
            placeholder="+1 555 555 0123"
            className="w-48"
          />
        </label>
        <Button
          variant="outline"
          disabled={!canSendTest || testSend.isPending}
          onClick={() =>
            testSend.mutate({ locationId: loc.locationId, to: testTo.trim() })
          }
        >
          {testSend.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-2 h-4 w-4" />
          )}
          Send test
        </Button>
      </div>
    </div>
  );
}

function UnconfiguredLocation({
  loc,
  onStartSetup,
}: {
  loc: MessagingSetupLocation;
  onStartSetup: () => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-dashed border-border bg-muted/20 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">Texting is not set up yet</p>
          <p className="text-sm text-muted-foreground">
            Start a guided setup and choose a new local texting number. Your
            existing clinic phone line will not be ported or changed.
          </p>
          {loc.existingPhone ? (
            <p className="text-xs text-muted-foreground">
              Existing phone on file: {loc.existingPhone}
            </p>
          ) : null}
        </div>
        <Button onClick={onStartSetup} className="shrink-0">
          Set up texting
        </Button>
      </div>
    </div>
  );
}
