"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { AlertCircle, ArrowLeft, Ban, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/common/empty-state";
import { toast } from "sonner";
import {
  CLIENT_ADDRESS_MAX_LENGTH,
  CLIENT_CITY_MAX_LENGTH,
  CLIENT_EMAIL_MAX_LENGTH,
  CLIENT_NAME_MAX_LENGTH,
  CLIENT_PHONE_MAX_LENGTH,
  CLIENT_STATE_MAX_LENGTH,
  CLIENT_ZIP_MAX_LENGTH,
  isOptionalClientTextValid,
  isRequiredClientTextValid,
} from "@/lib/clients/policy";
import { normalizeE164 } from "@/lib/messaging/phone";
import {
  phoneNumbersMatchForConsent,
  SMS_CONSENT_DISCLOSURE,
} from "@/lib/messaging/consent";

function EditClientLoadingPanel() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading client...
    </div>
  );
}

export default function EditClientPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking client access...
      </div>
    );
  }

  if (!canManageClientFormRole(session?.user?.role)) {
    return (
      <div className="max-w-2xl">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/clients/${params.id}`)}
          className="mb-4"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Client
        </Button>
        <EmptyState
          icon={AlertCircle}
          title="Client actions are read-only"
          description="Only staff roles with client write access can edit clients."
          action={{
            label: "Back to Client",
            onClick: () => router.push(`/clients/${params.id}`),
          }}
        />
      </div>
    );
  }

  return <EditClientForm />;
}

function canManageClientFormRole(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

function EditClientForm() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    zip: "",
  });
  const [smsConsent, setSmsConsent] = useState(false);
  const [smsConsentTouched, setSmsConsentTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    data: client,
    isLoading,
    error: loadError,
    refetch,
  } = trpc.clients.getById.useQuery(
    { id: params.id },
    { enabled: !!params.id }
  );

  useEffect(() => {
    if (client) {
      setForm({
        firstName: client.firstName ?? "",
        lastName: client.lastName ?? "",
        email: client.email ?? "",
        phone: client.phone ?? "",
        address: client.address ?? "",
        city: client.city ?? "",
        state: client.state ?? "",
        zip: client.zip ?? "",
      });
      setSmsConsent(client.smsConsent ?? false);
      setSmsConsentTouched(false);
    }
  }, [client]);

  const updateClient = trpc.clients.update.useMutation({
    onSuccess: () => {
      toast.success("Client updated");
      router.push(`/clients/${params.id}`);
    },
    onError: (err) => {
      toast.error(err.message);
      setError(err.message);
    },
  });
  const revokeSms = trpc.clients.revokeSms.useMutation({
    onSuccess: async ({ clientsRevoked }) => {
      toast.success(
        `Texting revoked for this number${clientsRevoked > 1 ? ` across ${clientsRevoked} matching client records` : ""}.`
      );
      setSmsConsent(false);
      setSmsConsentTouched(false);
      await refetch();
    },
    onError: (err) => {
      toast.error(err.message);
      setError(err.message);
    },
  });

  const smsPhoneValid = normalizeE164(form.phone) !== null;
  const persistedSmsPhone = normalizeE164(client?.phone);
  const phoneChanged = client
    ? !phoneNumbersMatchForConsent(client.phone, form.phone)
    : false;
  const canSubmit =
    isRequiredClientTextValid(form.firstName, CLIENT_NAME_MAX_LENGTH) &&
    isRequiredClientTextValid(form.lastName, CLIENT_NAME_MAX_LENGTH) &&
    isOptionalClientTextValid(form.email, CLIENT_EMAIL_MAX_LENGTH) &&
    isOptionalClientTextValid(form.phone, CLIENT_PHONE_MAX_LENGTH) &&
    isOptionalClientTextValid(form.address, CLIENT_ADDRESS_MAX_LENGTH) &&
    isOptionalClientTextValid(form.city, CLIENT_CITY_MAX_LENGTH) &&
    isOptionalClientTextValid(form.state, CLIENT_STATE_MAX_LENGTH) &&
    isOptionalClientTextValid(form.zip, CLIENT_ZIP_MAX_LENGTH) &&
    (!smsConsentTouched || !smsConsent || smsPhoneValid);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!client) {
      setError("Load the client before saving changes.");
      return;
    }
    if (smsConsentTouched && smsConsent && !smsPhoneValid) {
      setError(
        "Enter a valid mobile phone number before recording SMS consent."
      );
      return;
    }
    if (!canSubmit) {
      setError("Check required fields and field lengths.");
      return;
    }

    updateClient.mutate({
      id: params.id,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim() || undefined,
      phone: form.phone.trim() || undefined,
      address: form.address.trim() || undefined,
      city: form.city.trim() || undefined,
      state: form.state.trim() || undefined,
      zip: form.zip.trim() || undefined,
      ...(smsConsentTouched ? { smsConsent } : {}),
    });
  };

  const updateField = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field === "phone" && client) {
      // Consent belongs to the destination. Any material phone change requires
      // a fresh, explicit check after the new number is entered.
      setSmsConsent(
        phoneNumbersMatchForConsent(client.phone, value)
          ? (client.smsConsent ?? false)
          : false
      );
      setSmsConsentTouched(false);
    }
  };

  if (isLoading) {
    return <EditClientLoadingPanel />;
  }

  if (loadError || !client) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Unable to load client"
        description={
          loadError?.message ??
          "Choose a client from the Clients list before editing."
        }
        action={{
          label: "Back to Clients",
          onClick: () => router.push("/clients"),
          icon: ArrowLeft,
        }}
      />
    );
  }

  return (
    <div className="max-w-2xl">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push(`/clients/${params.id}`)}
        className="mb-4"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Client
      </Button>

      <h2 className="font-heading text-xl font-semibold">Edit Client</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Update client information
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="firstName">
              First Name *
            </label>
            <Input
              id="firstName"
              value={form.firstName}
              onChange={(e) => updateField("firstName", e.target.value)}
              placeholder="First name"
              className="mt-1"
              maxLength={CLIENT_NAME_MAX_LENGTH}
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="lastName">
              Last Name *
            </label>
            <Input
              id="lastName"
              value={form.lastName}
              onChange={(e) => updateField("lastName", e.target.value)}
              placeholder="Last name"
              className="mt-1"
              maxLength={CLIENT_NAME_MAX_LENGTH}
              required
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="email">
              Email
            </label>
            <Input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) => updateField("email", e.target.value)}
              placeholder="email@example.com"
              className="mt-1"
              maxLength={CLIENT_EMAIL_MAX_LENGTH}
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="phone">
              Phone
            </label>
            <Input
              id="phone"
              value={form.phone}
              onChange={(e) => updateField("phone", e.target.value)}
              placeholder="(555) 123-4567"
              className="mt-1"
              maxLength={CLIENT_PHONE_MAX_LENGTH}
            />
          </div>
        </div>

        <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm">
          <Checkbox
            checked={smsConsent}
            onChange={(e) => {
              setSmsConsent(e.target.checked);
              setSmsConsentTouched(true);
            }}
            disabled={!smsPhoneValid && !smsConsent}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">
              I confirm the client explicitly consented to SMS
            </span>
            <span className="block text-xs text-muted-foreground">
              {SMS_CONSENT_DISCLOSURE.snapshot}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Saving other details does not renew consent. Only check this after
              the client has read this disclosure or you have read it to them.
              {phoneChanged
                ? " The phone number changed, so prior SMS consent will be removed unless the client explicitly re-consents."
                : !smsPhoneValid && !smsConsent
                  ? " Enter a valid mobile phone number to record consent."
                  : ""}
            </span>
          </span>
        </label>

        <div className="rounded-md border border-border p-3">
          <p className="text-sm font-medium">Practice-wide do-not-text</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Use this when the client asks staff to stop texts. It immediately
            suppresses this phone number and clears SMS consent on every active
            client record that shares it. Saving the client or checking consent
            later will not silently remove the manual suppression.
            {phoneChanged
              ? " Save or discard the unsaved phone change before using this action."
              : ""}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={!persistedSmsPhone || phoneChanged || revokeSms.isPending}
            onClick={() => {
              setError(null);
              if (
                window.confirm(
                  "Stop all SMS to this phone number across the practice?"
                )
              ) {
                revokeSms.mutate({
                  id: params.id,
                  expectedPhone: persistedSmsPhone!,
                });
              }
            }}
          >
            {revokeSms.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Ban className="mr-2 h-4 w-4" />
            )}
            Do not text this number
          </Button>
        </div>

        <div>
          <label className="text-sm font-medium" htmlFor="address">
            Address
          </label>
          <Input
            id="address"
            value={form.address}
            onChange={(e) => updateField("address", e.target.value)}
            placeholder="Street address"
            className="mt-1"
            maxLength={CLIENT_ADDRESS_MAX_LENGTH}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-sm font-medium" htmlFor="city">
              City
            </label>
            <Input
              id="city"
              value={form.city}
              onChange={(e) => updateField("city", e.target.value)}
              placeholder="City"
              className="mt-1"
              maxLength={CLIENT_CITY_MAX_LENGTH}
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="state">
              State
            </label>
            <Input
              id="state"
              value={form.state}
              onChange={(e) => updateField("state", e.target.value)}
              placeholder="State"
              className="mt-1"
              maxLength={CLIENT_STATE_MAX_LENGTH}
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="zip">
              Zip
            </label>
            <Input
              id="zip"
              value={form.zip}
              onChange={(e) => updateField("zip", e.target.value)}
              placeholder="Zip code"
              className="mt-1"
              maxLength={CLIENT_ZIP_MAX_LENGTH}
            />
          </div>
        </div>

        <div className="flex gap-3 pt-4">
          <Button type="submit" disabled={!canSubmit || updateClient.isPending}>
            {updateClient.isPending ? "Saving..." : "Save Changes"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(`/clients/${params.id}`)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
