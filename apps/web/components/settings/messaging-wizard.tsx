"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  MessageSquare,
  Phone,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  defaultMessagingSetupMode,
  setupModeTitle,
  type MessagingSetupMode,
} from "@/lib/messaging/setup-wizard";
import {
  isMessagingAreaCodeInputValid,
  MESSAGING_AREA_CODE_LENGTH,
} from "@/lib/messaging/policy";
import { toast } from "sonner";

export type MessagingSetupLocation = {
  locationId: string;
  name: string;
  isPrimary: boolean;
  existingPhone: string | null;
  messaging: {
    senderE164: string | null;
    messagingProfileId: string | null;
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

type Step = "choose" | "confirm" | "registration" | "done";
type SearchNumber = { phoneNumber: string; monthlyCost: string | null };

/** Format a provider's raw monthly cost (e.g. "1.00000") as "$1.00". */
function formatMonthlyCost(cost: string | null): string | null {
  if (!cost) return null;
  const value = Number(cost);
  if (!Number.isFinite(value)) return null;
  return `$${value.toFixed(2)}`;
}

const STEPS: { id: Step; title: string }[] = [
  { id: "choose", title: "Choose a texting number" },
  { id: "confirm", title: "Confirm the number" },
  { id: "registration", title: "Carrier registration" },
  { id: "done", title: "Registration pending" },
];

export function MessagingWizard({
  location,
  open,
  onOpenChange,
  onChanged,
}: {
  location: MessagingSetupLocation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const defaultMode = useMemo(
    () => defaultMessagingSetupMode(location?.existingPhone),
    [location?.existingPhone]
  );
  const [step, setStep] = useState<Step>("choose");
  const [mode, setMode] = useState<MessagingSetupMode>(defaultMode);
  const [eligibility, setEligibility] = useState<{
    eligible: boolean;
    detail?: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [areaCode, setAreaCode] = useState("");
  const [numbers, setNumbers] = useState<SearchNumber[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<string | null>(null);
  const [provisionedSender, setProvisionedSender] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !location) return;
    setStep("choose");
    setMode(defaultMessagingSetupMode(location.existingPhone));
    setEligibility(null);
    setChecking(false);
    setAreaCode("");
    setNumbers([]);
    setSelectedNumber(null);
    setProvisionedSender(null);
  }, [open, location]);

  const provision = trpc.messaging.provisionNumber.useMutation({
    onSuccess: (result) => {
      setProvisionedSender(result.senderE164);
      setStep("done");
      toast.success("Number set up. Carrier registration is now pending.");
      onChanged();
    },
    onError: (e) => toast.error(e.message),
  });

  if (!open || !location) return null;
  const activeLocation = location;

  const currentIndex = STEPS.findIndex((s) => s.id === step);
  const canContinue =
    step === "choose" ||
    step === "registration" ||
    step === "done" ||
    (mode === "host" && eligibility?.eligible === true) ||
    (mode === "buy" && Boolean(selectedNumber));

  async function checkExisting() {
    if (!location) return;
    setChecking(true);
    try {
      const result = await utils.messaging.checkEligibility.fetch({
        locationId: location.locationId,
      });
      setEligibility(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Eligibility check failed");
    } finally {
      setChecking(false);
    }
  }

  async function searchNumbers() {
    if (!isMessagingAreaCodeInputValid(areaCode)) return;
    setChecking(true);
    try {
      const result = await utils.messaging.searchNumbers.fetch(
        areaCode ? { areaCode } : {}
      );
      setNumbers(result);
      setSelectedNumber(result[0]?.phoneNumber ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Number search failed");
    } finally {
      setChecking(false);
    }
  }

  function handleContinue() {
    if (step === "choose") {
      setStep("confirm");
      return;
    }
    if (step === "confirm") {
      if (mode === "host" && eligibility === null) {
        void checkExisting();
        return;
      }
      if (mode === "buy" && numbers.length === 0) {
        void searchNumbers();
        return;
      }
      setStep("registration");
      return;
    }
    if (step === "registration") {
      provision.mutate({
        locationId: activeLocation.locationId,
        mode,
        phoneNumber: mode === "buy" ? selectedNumber ?? undefined : undefined,
      });
      return;
    }
    onOpenChange(false);
  }

  function handleBack() {
    if (step === "choose" || provision.isPending) return;
    const previous = STEPS[Math.max(0, currentIndex - 1)]?.id ?? "choose";
    setStep(previous);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set up texting"
      className="fixed inset-0 z-[90] overflow-y-auto bg-[linear-gradient(135deg,#f8fafc_0%,#ecfdf5_52%,#f0fdfa_100%)] p-4 text-slate-950 sm:p-6"
    >
      <div className="flex min-h-full items-center justify-center">
        <div className="w-full max-w-2xl rounded-2xl border border-white/80 bg-white p-6 shadow-xl shadow-emerald-200/30 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700">
                <MessageSquare className="h-4 w-4" />
                Texting setup
              </div>
              <h2 className="mt-4 font-heading text-2xl font-bold tracking-tight text-slate-950">
                {STEPS[currentIndex]?.title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {location.name}
                {location.isPrimary ? " primary location" : ""}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close texting setup"
              onClick={() => onOpenChange(false)}
              className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 flex gap-1.5" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className={cn(
                  "h-1.5 flex-1 rounded-full transition-colors",
                  i <= currentIndex ? "bg-emerald-500" : "bg-slate-200"
                )}
              />
            ))}
          </div>

          <div className="mt-6 min-h-[18rem]">
            {step === "choose" ? (
              <ChooseStep
                mode={mode}
                setMode={setMode}
                existingPhone={location.existingPhone}
              />
            ) : null}
            {step === "confirm" ? (
              <ConfirmStep
                mode={mode}
                location={location}
                eligibility={eligibility}
                checking={checking}
                checkExisting={checkExisting}
                areaCode={areaCode}
                setAreaCode={setAreaCode}
                numbers={numbers}
                selectedNumber={selectedNumber}
                setSelectedNumber={setSelectedNumber}
                searchNumbers={searchNumbers}
              />
            ) : null}
            {step === "registration" ? (
              <RegistrationStep
                mode={mode}
                location={location}
                selectedNumber={selectedNumber}
              />
            ) : null}
            {step === "done" ? (
              <DoneStep sender={provisionedSender} />
            ) : null}
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-5">
            <Button
              type="button"
              variant="ghost"
              onClick={handleBack}
              disabled={step === "choose" || provision.isPending}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-500">
                Step {currentIndex + 1} of {STEPS.length}
              </span>
              <Button
                type="button"
                onClick={handleContinue}
                disabled={!canContinue || checking || provision.isPending}
              >
                {checking || provision.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {continueLabel({ step, mode, eligibility, numbers })}
                {step !== "done" && !checking && !provision.isPending ? (
                  <ArrowRight className="ml-2 h-4 w-4" />
                ) : null}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChooseStep({
  mode,
  setMode,
  existingPhone,
}: {
  mode: MessagingSetupMode;
  setMode: (mode: MessagingSetupMode) => void;
  existingPhone: string | null;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-slate-600">
        Most clinics start by text-enabling the phone number clients already
        know. You can also get a new local number for texting only.
      </p>
      <button
        type="button"
        onClick={() => setMode("host")}
        disabled={!existingPhone}
        className={cn(
          "w-full rounded-xl border p-4 text-left transition-colors",
          mode === "host"
            ? "border-emerald-500 bg-emerald-50"
            : "border-slate-200 hover:border-emerald-300",
          !existingPhone && "cursor-not-allowed opacity-60"
        )}
      >
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-600" />
          <div>
            <p className="font-medium text-slate-950">
              Text from your existing number
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {existingPhone
                ? `Keep ${existingPhone} for calls while OpenVPM adds texting.`
                : "Add a phone number in Practice Info to use this option."}
            </p>
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={() => setMode("buy")}
        className={cn(
          "w-full rounded-xl border p-4 text-left transition-colors",
          mode === "buy"
            ? "border-emerald-500 bg-emerald-50"
            : "border-slate-200 hover:border-emerald-300"
        )}
      >
        <div className="flex items-start gap-3">
          <Phone className="mt-0.5 h-5 w-5 text-emerald-600" />
          <div>
            <p className="font-medium text-slate-950">
              Get a new local texting number
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Choose a local number for outbound texts and client replies.
            </p>
          </div>
        </div>
      </button>
    </div>
  );
}

function ConfirmStep({
  mode,
  location,
  eligibility,
  checking,
  checkExisting,
  areaCode,
  setAreaCode,
  numbers,
  selectedNumber,
  setSelectedNumber,
  searchNumbers,
}: {
  mode: MessagingSetupMode;
  location: MessagingSetupLocation;
  eligibility: { eligible: boolean; detail?: string } | null;
  checking: boolean;
  checkExisting: () => void;
  areaCode: string;
  setAreaCode: (areaCode: string) => void;
  numbers: SearchNumber[];
  selectedNumber: string | null;
  setSelectedNumber: (phoneNumber: string) => void;
  searchNumbers: () => void;
}) {
  if (mode === "host") {
    return (
      <div className="space-y-5">
        <p className="text-sm leading-6 text-slate-600">
          We will check whether {location.existingPhone ?? "this number"} can be
          text-enabled without porting voice service.
        </p>
        {eligibility === null ? (
          <Button variant="outline" onClick={checkExisting} disabled={checking}>
            {checking ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-2 h-4 w-4" />
            )}
            Check eligibility
          </Button>
        ) : eligibility.eligible ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
              <Check className="h-4 w-4" />
              Eligible to text-enable
            </p>
            <p className="mt-2 text-sm text-emerald-700">
              Continue to review the carrier registration step.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">
              This number is not eligible yet.
            </p>
            <p className="mt-2 text-sm text-amber-800">
              {eligibility.detail ??
                "Choose a new local number instead, or update the location phone."}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-slate-600">
        Search for a local number. The selected number will be assigned to this
        location and carrier registration will begin after setup.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-slate-600">
            Area code
          </span>
          <Input
            value={areaCode}
            onChange={(e) =>
              setAreaCode(
                e.target.value
                  .replace(/\D/g, "")
                  .slice(0, MESSAGING_AREA_CODE_LENGTH)
              )
            }
            maxLength={MESSAGING_AREA_CODE_LENGTH}
            inputMode="numeric"
            pattern={`\\d{${MESSAGING_AREA_CODE_LENGTH}}`}
            placeholder="415"
            className="w-28 border-slate-300"
          />
        </label>
        <Button
          variant="outline"
          onClick={searchNumbers}
          disabled={checking || !isMessagingAreaCodeInputValid(areaCode)}
        >
          {checking ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Search className="mr-2 h-4 w-4" />
          )}
          Search numbers
        </Button>
      </div>
      {numbers.length > 0 ? (
        <div className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200">
          {numbers.map((n) => (
            <button
              type="button"
              key={n.phoneNumber}
              onClick={() => setSelectedNumber(n.phoneNumber)}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors",
                selectedNumber === n.phoneNumber
                  ? "bg-emerald-50"
                  : "hover:bg-slate-50"
              )}
            >
              <span className="font-medium text-slate-950">{n.phoneNumber}</span>
              <span className="flex items-center gap-2">
                {formatMonthlyCost(n.monthlyCost) ? (
                  <span className="text-xs text-slate-500">
                    {formatMonthlyCost(n.monthlyCost)}/mo
                  </span>
                ) : null}
                {selectedNumber === n.phoneNumber ? (
                  <Badge variant="success">Selected</Badge>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RegistrationStep({
  mode,
  location,
  selectedNumber,
}: {
  mode: MessagingSetupMode;
  location: MessagingSetupLocation;
  selectedNumber: string | null;
}) {
  const number =
    mode === "host" ? location.existingPhone ?? "your number" : selectedNumber;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 p-4">
        <p className="text-sm font-medium text-slate-950">
          {setupModeTitle(mode)}
        </p>
        <p className="mt-1 text-sm text-slate-600">{number}</p>
      </div>
      <div className="rounded-xl border border-teal-200 bg-teal-50 p-4">
        <p className="text-sm font-medium text-teal-950">
          Carrier approval is required before live US texting.
        </p>
        <p className="mt-2 text-sm leading-6 text-teal-800">
          OpenVPM will set up the number and keep sending off. After this step,
          complete the clinic&apos;s legal and consent details in Messaging
          settings; OpenVPM reviews them before any fee-bearing carrier
          submission.
        </p>
      </div>
    </div>
  );
}

function DoneStep({ sender }: { sender: string | null }) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-900">
          <Check className="h-4 w-4" />
          Number setup started
        </p>
        <p className="mt-2 text-sm leading-6 text-emerald-800">
          {sender ?? "Your number"} is saved and registration is pending. SMS
          sending stays off until carrier approval is active and an admin turns
          sending on.
        </p>
      </div>
      <div className="rounded-xl border border-slate-200 p-4">
        <p className="text-sm font-medium text-slate-950">
          Next: carrier approval
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Complete the US carrier registration form in Messaging settings.
          OpenVPM will review and submit it. When registration is active, turn
          sending on and send a test from the active location card.
        </p>
      </div>
    </div>
  );
}

function continueLabel({
  step,
  mode,
  eligibility,
  numbers,
}: {
  step: Step;
  mode: MessagingSetupMode;
  eligibility: { eligible: boolean; detail?: string } | null;
  numbers: SearchNumber[];
}) {
  if (step === "choose") return "Continue";
  if (step === "confirm" && mode === "host" && eligibility === null) {
    return "Check eligibility";
  }
  if (step === "confirm" && mode === "buy" && numbers.length === 0) {
    return "Search numbers";
  }
  if (step === "registration") return "Start setup";
  if (step === "done") return "Done";
  return "Continue";
}
