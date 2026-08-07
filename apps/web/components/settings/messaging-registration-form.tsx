"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

type FormState = {
  entityType: "PRIVATE_PROFIT" | "NON_PROFIT";
  displayName: string;
  legalName: string;
  taxId: string;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  businessPhone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  website: string;
  privacyPolicyUrl: string;
  termsUrl: string;
};

const EMPTY_FORM: FormState = {
  entityType: "PRIVATE_PROFIT",
  displayName: "",
  legalName: "",
  taxId: "",
  contactFirstName: "",
  contactLastName: "",
  contactEmail: "",
  businessPhone: "",
  street: "",
  city: "",
  state: "",
  postalCode: "",
  website: "",
  privacyPolicyUrl: "",
  termsUrl: "",
};

export function MessagingRegistrationForm() {
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.messaging.getRegistration.useQuery();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [attested, setAttested] = useState(false);

  useEffect(() => {
    if (!data) return;
    setForm({
      entityType: data.entityType,
      displayName: data.displayName,
      legalName: data.legalName,
      taxId: "",
      contactFirstName: data.contactFirstName,
      contactLastName: data.contactLastName,
      contactEmail: data.contactEmail,
      businessPhone: data.businessPhone,
      street: data.street,
      city: data.city,
      state: data.state,
      postalCode: data.postalCode,
      website: data.website,
      privacyPolicyUrl: data.privacyPolicyUrl,
      termsUrl: data.termsUrl,
    });
  }, [data]);

  const submitted = Boolean(
    data?.providerBrandStatus || data?.providerCampaignStatus
  );
  const save = trpc.messaging.saveRegistration.useMutation({
    onSuccess: () => {
      toast.success("Carrier registration details saved for OpenVPM review.");
      setForm((current) => ({ ...current, taxId: "" }));
      setAttested(false);
      utils.messaging.getRegistration.invalidate();
    },
    onError: (mutationError) => toast.error(mutationError.message),
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border p-5 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading carrier
        registration…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertTriangle className="mr-2 inline h-4 w-4" /> {error.message}
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4" /> US carrier registration
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            US carriers verify the clinic and its texting use case before
            messages can send. Saving this form does not submit or charge
            anything; an OpenVPM operator reviews it first.
          </p>
        </div>
        {data ? (
          <Badge
            variant={
              data.status === "active"
                ? "success"
                : data.status === "action_required" || data.status === "pending"
                  ? "warning"
                  : data.status === "failed" || data.status === "suspended"
                    ? "destructive"
                    : "secondary"
            }
          >
            {data.status.replace("_", " ")}
          </Badge>
        ) : null}
      </div>

      {data?.statusDetail ? (
        <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
          {data.status === "active" ? (
            <CheckCircle2 className="mr-2 inline h-4 w-4 text-emerald-600" />
          ) : null}
          {data.statusDetail}
          {data.lastSyncedAt
            ? ` Last checked ${new Date(data.lastSyncedAt).toLocaleString()}.`
            : ""}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Organization type">
          <select
            value={form.entityType}
            onChange={(event) =>
              update(
                "entityType",
                event.target.value as FormState["entityType"]
              )
            }
            disabled={submitted}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="PRIVATE_PROFIT">
              Private practice / for-profit
            </option>
            <option value="NON_PROFIT">Non-profit</option>
          </select>
        </Field>
        <TextField
          label="Clinic name clients know"
          value={form.displayName}
          onChange={(v) => update("displayName", v)}
          disabled={submitted}
        />
        <TextField
          label="Legal business name"
          value={form.legalName}
          onChange={(v) => update("legalName", v)}
          disabled={submitted}
        />
        <Field
          label={`Federal tax ID${data?.hasTaxId ? ` (saved ••••${data.taxIdLast4})` : ""}`}
        >
          <Input
            type="password"
            autoComplete="off"
            value={form.taxId}
            onChange={(event) => update("taxId", event.target.value)}
            placeholder={
              data?.hasTaxId ? "Leave blank to keep saved value" : "12-3456789"
            }
            disabled={submitted}
          />
        </Field>
        <TextField
          label="Contact first name"
          value={form.contactFirstName}
          onChange={(v) => update("contactFirstName", v)}
          disabled={submitted}
        />
        <TextField
          label="Contact last name"
          value={form.contactLastName}
          onChange={(v) => update("contactLastName", v)}
          disabled={submitted}
        />
        <TextField
          label="Contact email"
          type="email"
          value={form.contactEmail}
          onChange={(v) => update("contactEmail", v)}
          disabled={submitted}
        />
        <TextField
          label="Business phone"
          type="tel"
          value={form.businessPhone}
          onChange={(v) => update("businessPhone", v)}
          disabled={submitted}
        />
        <TextField
          label="Street address"
          value={form.street}
          onChange={(v) => update("street", v)}
          disabled={submitted}
        />
        <TextField
          label="City"
          value={form.city}
          onChange={(v) => update("city", v)}
          disabled={submitted}
        />
        <TextField
          label="State"
          value={form.state}
          onChange={(v) => update("state", v.toUpperCase().slice(0, 2))}
          disabled={submitted}
        />
        <TextField
          label="ZIP code"
          value={form.postalCode}
          onChange={(v) => update("postalCode", v)}
          disabled={submitted}
        />
        <TextField
          label="Clinic website (HTTPS)"
          type="url"
          value={form.website}
          onChange={(v) => update("website", v)}
          disabled={submitted}
        />
        <TextField
          label="SMS privacy policy URL"
          type="url"
          value={form.privacyPolicyUrl}
          onChange={(v) => update("privacyPolicyUrl", v)}
          disabled={submitted}
        />
        <TextField
          label="SMS terms URL"
          type="url"
          value={form.termsUrl}
          onChange={(v) => update("termsUrl", v)}
          disabled={submitted}
        />
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <div className="space-y-2">
          <label className="flex max-w-2xl items-start gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
              disabled={submitted}
              className="mt-0.5"
            />
            <span>
              I certify these details are accurate, clients consent before any
              SMS is sent, and the linked policies explain message frequency,
              message/data rates, HELP, and STOP opt-out.
            </span>
          </label>
          <p className="text-xs text-muted-foreground">
            Tax IDs are encrypted before storage and are never shown again.
          </p>
        </div>
        <Button
          type="button"
          disabled={submitted || !attested || save.isPending}
          onClick={() =>
            save.mutate({
              ...form,
              taxId: form.taxId.trim() || undefined,
              certifyAccuracyAndConsent: true,
            })
          }
        >
          {save.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          {data ? "Save changes" : "Save for review"}
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel" | "url";
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </Field>
  );
}
