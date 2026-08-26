"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  ArrowLeft,
  Clock,
  Globe,
  Mail,
  MessageSquare,
  Phone,
  MapPin,
  Copy,
  ExternalLink,
  RefreshCw,
  HeartPulse,
  Loader2,
  PawPrint,
  Plus,
  Smartphone,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  emitGuideSignal,
  GUIDE_SIGNALS,
} from "@/components/tour/guide-signals";
import { toast } from "sonner";
import { useCurrencyFormatter } from "@/lib/locale/useCurrency";
import {
  formatClinicalDate,
  formatClinicalDateTime,
} from "@/lib/records/clinical-dates";
import { communicationStatusLabel } from "@/lib/communications/status";

const speciesEmoji: Record<string, string> = {
  canine: "\uD83D\uDC36",
  feline: "\uD83D\uDC31",
  avian: "\uD83D\uDC26",
  rabbit: "\uD83D\uDC30",
  reptile: "\uD83E\uDD8E",
  equine: "\uD83D\uDC34",
  other: "\uD83D\uDC3E",
};

const communicationChannelLabels = {
  phone: "Phone",
  sms: "SMS",
  email: "Email",
  portal: "Portal",
} as const;

function canManageClientDetailsRole(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

function canManageWellnessMembershipRole(role?: string | null): boolean {
  return role === "admin" || role === "front_desk";
}

function CommunicationChannelIcon({
  channel,
}: {
  channel: keyof typeof communicationChannelLabels;
}) {
  const Icon =
    channel === "sms"
      ? Smartphone
      : channel === "email"
        ? Mail
        : channel === "portal"
          ? Globe
          : Phone;
  return <Icon className="h-3.5 w-3.5" />;
}

function ClientDetailLoadingPanel() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading client...
    </div>
  );
}

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const [confirmRotatePortal, setConfirmRotatePortal] = useState(false);
  const [issuedPortalToken, setIssuedPortalToken] = useState<string | null>(
    null,
  );
  const canManageClientDetails = canManageClientDetailsRole(
    session?.user?.role
  );
  const canManageWellnessMemberships = canManageWellnessMembershipRole(
    session?.user?.role
  );

  const { data: client, isLoading, error } = trpc.clients.getById.useQuery(
    { id: params.id },
    { enabled: !!params.id }
  );
  const rotatePortalToken = trpc.clients.rotatePortalAccessToken.useMutation({
    onSuccess: (result) => {
      setIssuedPortalToken(result.accessToken);
      utils.clients.getById.invalidate({ id: params.id });
      setConfirmRotatePortal(false);
      toast.success("One-time portal link created");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  if (isLoading) {
    return <ClientDetailLoadingPanel />;
  }

  if (error || !client) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Unable to load client"
        description={
          error?.message ??
          "Choose a client from the Clients list before opening the detail page."
        }
        action={{
          label: "Back to Clients",
          onClick: () => router.push("/clients"),
          icon: ArrowLeft,
        }}
      />
    );
  }

  const address = [client.address, client.city, client.state, client.zip]
    .filter(Boolean)
    .join(", ");
  const portalPath = issuedPortalToken
    ? `/portal/access/${issuedPortalToken}`
    : null;

  const copyPortalLink = async () => {
    if (!portalPath) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${portalPath}`
      );
      toast.success("Portal link copied");
      emitGuideSignal(GUIDE_SIGNALS.portalLinkCopied);
    } catch {
      toast.error("Could not copy portal link");
    }
  };

  const handlePortalTokenAction = () => {
    if (!canManageClientDetails) return;
    if (client.portalAccessState !== "not_issued" && !confirmRotatePortal) {
      setConfirmRotatePortal(true);
      return;
    }
    rotatePortalToken.mutate({ id: client.id });
  };

  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push("/clients")}
        className="mb-4"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Clients
      </Button>

      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-heading text-xl font-semibold">
              {client.firstName} {client.lastName}
            </h2>
            <div className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
              {client.email && (
                <span className="flex items-center gap-2">
                  <Mail className="h-4 w-4" />
                  {client.email}
                </span>
              )}
              {client.phone && (
                <span className="flex items-center gap-2">
                  <Phone className="h-4 w-4" />
                  {client.phone}
                </span>
              )}
              {address && (
                <span className="flex items-center gap-2">
                  <MapPin className="h-4 w-4" />
                  {address}
                </span>
              )}
            </div>
          </div>
          {canManageClientDetails && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/clients/${client.id}/edit`)}
            >
              Edit
            </Button>
          )}
        </div>
      </div>

      <div
        data-tour="client-portal-link"
        className="mt-6 rounded-lg border border-border bg-card p-6"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="font-heading text-lg font-semibold">
              Client Portal
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Create a private, one-time link so the client can start a secure
              portal session. Links expire after 15 minutes.
            </p>
            {!canManageClientDetails ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Portal links are available to staff with client write access.
              </p>
            ) : portalPath ? (
              <div className="mt-3 break-all rounded-md border border-border bg-muted px-3 py-2 text-sm">
                {portalPath}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                {client.portalAccessState === "ready"
                  ? "A one-time link is active, but its secret is no longer displayed. Reset access to create another."
                  : client.portalAccessState === "consumed"
                    ? "The client has used their latest link. Reset access only if they need a new session."
                    : client.portalAccessState === "expired"
                      ? "The latest one-time link has expired."
                      : "No portal link has been issued for this client yet."}
              </p>
            )}
            {confirmRotatePortal ? (
              <p className="mt-2 text-xs text-amber-700">
                Resetting access invalidates the previous link and signs this
                client out of every active portal session.
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {canManageClientDetails && portalPath ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyPortalLink}
                  className="gap-2"
                >
                  <Copy className="h-4 w-4" />
                  Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  asChild
                  className="gap-2"
                >
                  <a href={portalPath} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    Open
                  </a>
                </Button>
              </>
            ) : null}
            {canManageClientDetails && (
              <Button
                variant={confirmRotatePortal ? "destructive" : "outline"}
                size="sm"
                onClick={handlePortalTokenAction}
                disabled={rotatePortalToken.isPending}
                className="gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                {rotatePortalToken.isPending
                  ? "Updating..."
                  : client.portalAccessState !== "not_issued"
                    ? confirmRotatePortal
                      ? "Confirm Reset"
                      : "Reset Access"
                    : "Create Link"}
              </Button>
            )}
            {canManageClientDetails && confirmRotatePortal ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRotatePortal(false)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <CommunicationLogPanel clientId={client.id} />

      <WellnessEnrollmentPanel
        client={client}
        canManageWellnessMemberships={canManageWellnessMemberships}
      />

      <div className="mt-6">
        <h3 className="font-heading text-lg font-semibold mb-4">
          Patients ({client.patients.length})
        </h3>
        {client.patients.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {client.patients.map((patient) => (
              <div
                key={patient.id}
                onClick={() => router.push(`/patients/${patient.id}`)}
                className="cursor-pointer rounded-lg border border-border bg-card p-4 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">
                    {speciesEmoji[patient.species ?? "other"] ?? "\uD83D\uDC3E"}
                  </span>
                  <span className="font-medium">{patient.name}</span>
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {patient.species &&
                    patient.species.charAt(0).toUpperCase() +
                      patient.species.slice(1)}
                  {patient.breed ? ` \u00B7 ${patient.breed}` : ""}
                </div>
                <div className="mt-1">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      patient.status === "active"
                        ? "bg-emerald-100 text-emerald-700"
                        : patient.status === "deceased"
                          ? "bg-gray-100 text-gray-600"
                          : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {patient.status ?? "active"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={PawPrint}
            title="No patients for this client yet"
            action={
              canManageClientDetails
                ? {
                    label: "Add patient",
                    onClick: () => {
                      const ownerName = `${client.firstName} ${client.lastName}`;
                      router.push(
                        `/patients/new?clientId=${encodeURIComponent(client.id)}&clientName=${encodeURIComponent(ownerName)}`
                      );
                    },
                    icon: Plus,
                  }
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function CommunicationLogPanel({ clientId }: { clientId: string }) {
  const {
    data: communicationSettings,
    isLoading: settingsLoading,
    error: settingsError,
  } = trpc.communications.settings.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const {
    data: communications,
    isLoading,
    error,
  } = trpc.communications.getByClient.useQuery(
    { clientId },
    { enabled: !!clientId }
  );
  const communicationLogError = error ?? settingsError;
  const isCommunicationLogLoading = isLoading || settingsLoading;
  const communicationSettingsMissing =
    !settingsLoading && !settingsError && !communicationSettings;
  const communicationsMissing = !isLoading && !error && !communications;
  const communicationLogMissing =
    communicationSettingsMissing || communicationsMissing;
  const verifiedCommunicationSettings =
    communicationLogError || isCommunicationLogLoading || communicationLogMissing
      ? null
      : communicationSettings;

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <div>
        <h3 className="font-heading text-lg font-semibold">
          Communication Log
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Calls, texts, emails, and portal requests linked to this client.
        </p>
      </div>

      {communicationLogError || communicationLogMissing ? (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {communicationLogError?.message ??
            "Unable to load communication log. Please retry."}
        </div>
      ) : isCommunicationLogLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading communication log...
        </div>
      ) : verifiedCommunicationSettings &&
        communications &&
        communications.length > 0 ? (
        <div className="mt-4 divide-y divide-border rounded-lg border border-border">
          {communications.map((message) => {
            const channel =
              message.channel as keyof typeof communicationChannelLabels;
            const directionLabel =
              message.direction === "outbound" ? "Outbound" : "Inbound";
            const statusLabel = communicationStatusLabel(message);

            return (
              <article key={message.id} className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="gap-1.5">
                        <CommunicationChannelIcon channel={channel} />
                        {communicationChannelLabels[channel]}
                      </Badge>
                      <span className="text-xs font-medium uppercase text-muted-foreground">
                        {directionLabel}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {statusLabel}
                      </span>
                    </div>
                    {message.subject ? (
                      <p className="text-sm font-medium">{message.subject}</p>
                    ) : null}
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                      {message.content?.trim() || "No content"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {formatClinicalDateTime(
                      message.createdAt,
                      verifiedCommunicationSettings.timezone
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          className="mt-4"
          icon={MessageSquare}
          title="No communication log yet"
          description="Messages, calls, and portal requests linked to this client will appear here."
        />
      )}
    </div>
  );
}

function WellnessEnrollmentPanel({
  client,
  canManageWellnessMemberships,
}: {
  client: {
    id: string;
    patients: Array<{
      id: string;
      name: string;
      species: string | null;
      status: string | null;
    }>;
  };
  canManageWellnessMemberships: boolean;
}) {
  const formatCurrency = useCurrencyFormatter();
  const utils = trpc.useUtils();
  const { data: plans, isLoading, error } = trpc.wellness.listPlans.useQuery();
  const enrollmentsQuery = trpc.wellness.listEnrollments.useQuery({
    clientId: client.id,
    status: "active",
  });
  const plansMissing = !isLoading && !error && !plans;
  const enrollmentsMissing =
    !enrollmentsQuery.isLoading &&
    !enrollmentsQuery.error &&
    !enrollmentsQuery.data;
  const verifiedWellnessPlans =
    error || plansMissing || !plans ? null : plans;
  const verifiedEnrollments =
    enrollmentsQuery.error ||
    enrollmentsQuery.isLoading ||
    enrollmentsMissing ||
    !enrollmentsQuery.data
      ? null
      : enrollmentsQuery.data;
  const enrollmentsReady = verifiedEnrollments !== null;
  const activePlans = verifiedWellnessPlans
    ? verifiedWellnessPlans.filter((plan) => plan.active)
    : [];
  const activeEnrollments = verifiedEnrollments ?? [];
  const activePatients = client.patients.filter(
    (patient) => (patient.status ?? "active") === "active"
  );
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [selectedPatientId, setSelectedPatientId] = useState(
    activePatients[0]?.id ?? ""
  );
  const enroll = trpc.wellness.enroll.useMutation({
    onSuccess: () => {
      toast.success("Wellness enrollment created");
      utils.wellness.listEnrollments.invalidate({
        clientId: client.id,
        status: "active",
      });
      utils.wellness.listDue.invalidate();
      setSelectedPlanId("");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const cancelEnrollment = trpc.wellness.cancel.useMutation({
    onSuccess: () => {
      toast.success("Wellness enrollment cancelled");
      utils.wellness.listEnrollments.invalidate({
        clientId: client.id,
        status: "active",
      });
      utils.wellness.listDue.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const handleCancelEnrollment = (enrollmentId: string) => {
    if (!window.confirm("Cancel this wellness enrollment?")) return;
    cancelEnrollment.mutate({ enrollmentId });
  };
  const canCreateEnrollment =
    canManageWellnessMemberships &&
    Boolean(selectedPlanId) &&
    !enroll.isPending &&
    enrollmentsReady;

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <HeartPulse className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-heading text-lg font-semibold">
                Wellness Membership
              </h3>
              <Badge variant="secondary">Invoice schedule</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {isLoading
                ? "Loading plans..."
                : error
                ? error.message
                : plansMissing
                ? "Unable to load wellness plans. Please retry."
                : activePlans.length === 0
                ? "No active wellness plans configured."
                : `${activePlans.length} active plan${activePlans.length === 1 ? "" : "s"}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Enrollment creates scheduled invoices; saved cards are not
              auto-charged.
            </p>
          </div>
        </div>

        {canManageWellnessMemberships && activePlans.length > 0 && (
          <div className="grid w-full gap-2 sm:grid-cols-[1fr_1fr_auto] lg:max-w-2xl">
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={selectedPlanId}
              onChange={(e) => setSelectedPlanId(e.target.value)}
              disabled={enroll.isPending || !enrollmentsReady}
            >
              <option value="">Select plan</option>
              {activePlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={selectedPatientId}
              onChange={(e) => setSelectedPatientId(e.target.value)}
              disabled={enroll.isPending || !enrollmentsReady}
            >
              <option value="">Client account</option>
              {activePatients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!canCreateEnrollment}
              onClick={() =>
                enroll.mutate({
                  planId: selectedPlanId,
                  clientId: client.id,
                  patientId: selectedPatientId || undefined,
                })
              }
            >
              {enroll.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <HeartPulse className="mr-2 h-4 w-4" />
              )}
              Enroll
            </Button>
          </div>
        )}
      </div>
      {enrollmentsQuery.error ? (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {enrollmentsQuery.error.message}
        </div>
      ) : enrollmentsMissing ? (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Unable to load wellness memberships. Please retry.
        </div>
      ) : enrollmentsQuery.isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading memberships...
        </div>
      ) : activeEnrollments.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Plan</th>
                <th className="px-4 py-3 text-left font-medium">Patient</th>
                <th className="px-4 py-3 text-left font-medium">
                  Next Invoice
                </th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">
                  {canManageWellnessMemberships ? "Actions" : "Access"}
                </th>
              </tr>
            </thead>
            <tbody>
              {activeEnrollments.map((enrollment) => (
                <tr
                  key={enrollment.enrollmentId}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-3 font-medium">
                    {enrollment.planName}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {enrollment.patientName || "Client account"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatClinicalDate(
                      enrollment.nextBillingDate,
                      enrollment.timezone,
                      "\u2014"
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatCurrency(enrollment.price)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canManageWellnessMemberships ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={cancelEnrollment.isPending}
                        onClick={() =>
                          handleCancelEnrollment(enrollment.enrollmentId)
                        }
                        title="Cancel enrollment"
                      >
                        {cancelEnrollment.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <X className="h-4 w-4 text-destructive" />
                        )}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Read-only
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
