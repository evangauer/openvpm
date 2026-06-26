"use client";

import { useState } from "react";
import {
  Loader2,
  MessageSquare,
  Phone,
  Plus,
  Send,
  Check,
  ShieldCheck,
  Search,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

type StatusLocation = {
  locationId: string;
  name: string;
  isPrimary: boolean;
  existingPhone: string | null;
  messaging: {
    senderE164: string | null;
    numberSource: "hosted" | "purchased" | "toll_free" | null;
    registrationStatus:
      | "not_started"
      | "pending"
      | "active"
      | "action_required"
      | "failed"
      | "suspended";
    registrationDetail: string | null;
    enabled: boolean;
  } | null;
};

const REGISTRATION_BADGE: Record<
  NonNullable<StatusLocation["messaging"]>["registrationStatus"],
  { label: string; variant: "success" | "warning" | "destructive" | "secondary" }
> = {
  not_started: { label: "Not started", variant: "secondary" },
  pending: { label: "Registration pending", variant: "warning" },
  active: { label: "Active", variant: "success" },
  action_required: { label: "Action required", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  suspended: { label: "Suspended", variant: "destructive" },
};

export function MessagingTab() {
  const { data, isLoading } = trpc.messaging.getStatus.useQuery();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const usage = data?.usage;
  const consent = data?.consent;

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
        {(data?.locations ?? []).map((loc) => (
          <LocationCard key={loc.locationId} loc={loc as StatusLocation} />
        ))}
        {data?.locations.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
            Add a location in Practice Info to set up texting.
          </p>
        )}
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

function LocationCard({ loc }: { loc: StatusLocation }) {
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
        <ConfiguredLocation loc={loc} onChanged={refresh} />
      ) : (
        <SetupFlow loc={loc} onChanged={refresh} />
      )}
    </div>
  );
}

function ConfiguredLocation({
  loc,
  onChanged,
}: {
  loc: StatusLocation;
  onChanged: () => void;
}) {
  const m = loc.messaging!;
  const [testTo, setTestTo] = useState("");

  const setEnabled = trpc.messaging.setEnabled.useMutation({
    onSuccess: () => onChanged(),
    onError: (e) => toast.error(e.message),
  });
  const testSend = trpc.messaging.testSend.useMutation({
    onSuccess: () => toast.success("Test message sent"),
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Phone className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{m.senderE164 ?? "—"}</span>
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

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={m.enabled}
          disabled={setEnabled.isPending}
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
            placeholder="+1 555 555 0123"
            className="w-48"
          />
        </label>
        <Button
          variant="outline"
          disabled={!testTo || testSend.isPending}
          onClick={() => testSend.mutate({ locationId: loc.locationId, to: testTo })}
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

function SetupFlow({
  loc,
  onChanged,
}: {
  loc: StatusLocation;
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const [eligibility, setEligibility] = useState<{
    eligible: boolean;
    detail?: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [areaCode, setAreaCode] = useState("");
  const [numbers, setNumbers] = useState<{ phoneNumber: string; monthlyCost: string | null }[]>([]);
  const [searching, setSearching] = useState(false);

  const provision = trpc.messaging.provisionNumber.useMutation({
    onSuccess: () => {
      toast.success("Number set up — carrier registration is now in progress.");
      onChanged();
    },
    onError: (e) => toast.error(e.message),
  });

  async function checkExisting() {
    setChecking(true);
    try {
      const r = await utils.messaging.checkEligibility.fetch({ locationId: loc.locationId });
      setEligibility(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Eligibility check failed");
    } finally {
      setChecking(false);
    }
  }

  async function search() {
    setSearching(true);
    try {
      const r = await utils.messaging.searchNumbers.fetch(
        areaCode ? { areaCode } : {}
      );
      setNumbers(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Number search failed");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="mt-4 space-y-5">
      <p className="text-sm text-muted-foreground">
        Set up texting for this location. Most clinics text-enable the number
        clients already know.
      </p>

      {/* Option 1: text-enable existing number */}
      <div className="space-y-2 rounded-md border border-border p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="h-4 w-4" /> Text-enable your existing number
        </div>
        {loc.existingPhone ? (
          <>
            <p className="text-xs text-muted-foreground">
              Keep {loc.existingPhone} for calls; we add texting to it (no porting).
            </p>
            {eligibility === null ? (
              <Button variant="outline" size="sm" onClick={checkExisting} disabled={checking}>
                {checking ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                Check eligibility
              </Button>
            ) : eligibility.eligible ? (
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" /> Eligible to text-enable.
                </p>
                <Button
                  size="sm"
                  disabled={provision.isPending}
                  onClick={() =>
                    provision.mutate({ locationId: loc.locationId, mode: "host" })
                  }
                >
                  {provision.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Text-enable {loc.existingPhone}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {eligibility.detail ??
                  "This number can't be text-enabled. Use a new local number below."}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Add a phone number to this location (Practice Info) to text-enable it.
          </p>
        )}
      </div>

      {/* Option 2: new local number */}
      <div className="space-y-2 rounded-md border border-border p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Plus className="h-4 w-4" /> Get a new local number
        </div>
        <div className="flex items-end gap-2">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Area code (optional)
            </span>
            <Input
              value={areaCode}
              onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))}
              placeholder="415"
              className="w-24"
            />
          </label>
          <Button variant="outline" size="sm" onClick={search} disabled={searching}>
            {searching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-2 h-4 w-4" />
            )}
            Search
          </Button>
        </div>
        {numbers.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {numbers.map((n) => (
              <li
                key={n.phoneNumber}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="font-medium">{n.phoneNumber}</span>
                <div className="flex items-center gap-2">
                  {n.monthlyCost && (
                    <span className="text-xs text-muted-foreground">
                      ${n.monthlyCost}/mo
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={provision.isPending}
                    onClick={() =>
                      provision.mutate({
                        locationId: loc.locationId,
                        mode: "buy",
                        phoneNumber: n.phoneNumber,
                      })
                    }
                  >
                    Use
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
