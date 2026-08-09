"use client";

import { useState, useCallback, useRef, Suspense } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import {
  Settings,
  Users,
  Calendar,
  DoorOpen,
  Plus,
  Pencil,
  Trash2,
  Save,
  X,
  Loader2,
  ShieldAlert,
  Database,
  Download,
  Upload,
  FileSpreadsheet,
  Check,
  AlertTriangle,
  Layers,
  CreditCard,
  ImageIcon,
  Mail,
  Copy,
  MessageSquare,
  Globe,
  MapPin,
  Star,
  HeartPulse,
  Compass,
  ReceiptText,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/common/empty-state";
import { AccentColorPicker } from "@/components/brand/accent-color-picker";
import { MessagingTab } from "@/components/settings/messaging-tab";
import { BookingTab } from "@/components/settings/booking-tab";
import { ServicesTab } from "@/components/settings/services-tab";
import { useWelcome } from "@/components/welcome/welcome-provider";
import { cn, isValidEmail } from "@/lib/utils";
import { toast } from "sonner";
import { regionDefaults } from "@/lib/locale/format";
import { useCurrencyFormatter } from "@/lib/locale/useCurrency";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import { trialCalendarDaysLeft } from "@/lib/billing/trial-days";
import {
  PRACTICE_BACKUP_JSON_MAX_BYTES,
  PRACTICE_BACKUP_JSON_SIZE_MESSAGE,
  isPracticeBackupJsonSizeValid,
} from "@/lib/backup/policy";
import {
  isWellnessPlanPriceInputValid,
  WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH,
  WELLNESS_PLAN_NAME_MAX_LENGTH,
  WELLNESS_PLAN_PRICE_MAX,
  WELLNESS_PLAN_PRICE_MIN,
  WELLNESS_PLAN_PRICE_SCALE,
} from "@/lib/wellness/policy";
import {
  isTreatmentTemplateItemTotalValid,
  isTreatmentTemplateQuantityValid,
  isTreatmentTemplateUnitPriceInputValid,
  TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH,
  TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH,
  TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX,
  TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN,
  TREATMENT_TEMPLATE_MAX_ITEMS,
  TREATMENT_TEMPLATE_NAME_MAX_LENGTH,
  TREATMENT_TEMPLATE_UNIT_PRICE_MAX,
} from "@/lib/templates/policy";
import {
  CLIENT_UPLOAD_TIMEOUT_MS,
  fetchWithClientTimeout,
} from "@/lib/client-fetch";
import {
  IMAGE_UPLOAD_POLICY_MESSAGE,
  isImageUploadFileValid,
} from "@/lib/upload-policy";
import {
  IMPORT_CSV_MAX_BYTES,
  isImportCsvSizeValid,
} from "@/lib/import/policy";
import {
  MIGRATION_SOURCES,
  MIGRATION_STEPS,
  type MigrationImportMode,
} from "@/lib/import/sources";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "@/lib/auth-password-policy";
import {
  ACCOUNT_DELETION_REASON_MAX_LENGTH,
  APPOINTMENT_TYPE_DURATION_MAX_MINUTES,
  APPOINTMENT_TYPE_DURATION_MIN_MINUTES,
  APPOINTMENT_TYPE_NAME_MAX_LENGTH,
  LOCATION_NAME_MAX_LENGTH,
  PRACTICE_NAME_MAX_LENGTH,
  ROOM_NAME_MAX_LENGTH,
  SETTINGS_ADDRESS_MAX_LENGTH,
  SETTINGS_EMAIL_MAX_LENGTH,
  SETTINGS_PHONE_MAX_LENGTH,
  SETTINGS_TAX_RATE_PATTERN,
  SETTINGS_VAT_NUMBER_MAX_LENGTH,
  SETTINGS_WEBSITE_MAX_LENGTH,
  STAFF_LICENSE_NUMBER_MAX_LENGTH,
  STAFF_NAME_MAX_LENGTH,
  isSupportedPracticeTimezone,
} from "@/lib/settings-policy";

// ── Types ───────────────────────────────────────────────────
type Tab =
  | "practice"
  | "locations"
  | "staff"
  | "appointmentTypes"
  | "rooms"
  | "services"
  | "data"
  | "templates"
  | "wellness"
  | "messaging"
  | "booking"
  | "billing";

const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "practice", label: "Practice Info", icon: Settings },
  { id: "locations", label: "Locations", icon: MapPin },
  { id: "staff", label: "Staff", icon: Users },
  { id: "appointmentTypes", label: "Appointment Types", icon: Calendar },
  { id: "rooms", label: "Rooms", icon: DoorOpen },
  { id: "services", label: "Services & Pricing", icon: ReceiptText },
  { id: "data", label: "Data", icon: Database },
  { id: "templates", label: "Templates", icon: Layers },
  { id: "wellness", label: "Wellness Plans", icon: HeartPulse },
  { id: "messaging", label: "Messaging", icon: MessageSquare },
  { id: "booking", label: "Online Booking", icon: Globe },
  { id: "billing", label: "Plan & Billing", icon: CreditCard },
];

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "Europe/London",
  "Europe/Dublin",
  "Australia/Sydney",
];

// Supported regions (ISO 3166-1 alpha-2). US-first; others are UK-ready.
const COUNTRIES: { code: string; label: string }[] = [
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "IE", label: "Ireland" },
  { code: "CA", label: "Canada" },
  { code: "AU", label: "Australia" },
];

const CURRENCIES = ["usd", "gbp", "eur", "cad", "aud"];

const PRESET_COLORS = [
  "#0d9488",
  "#dc2626",
  "#2563eb",
  "#7c3aed",
  "#ea580c",
  "#16a34a",
  "#f59e0b",
  "#6b7280",
];

// Accent swatches now live in the shared <AccentColorPicker /> (presets +
// custom hex), reused by Settings and the onboarding journey.

const ROLE_BADGE: Record<string, string> = {
  admin:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  veterinarian:
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400",
  technician:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  front_desk:
    "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
  viewer:
    "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-400",
};

const ROOM_TYPES = ["exam", "surgery", "treatment", "boarding"] as const;

type PracticeInfoForm = {
  name: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  timezone: string;
  country: string;
  currency: string;
  taxRatePercent: string;
  vatNumber: string;
};

function formatSettingsDateTime(
  value: Date | string | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return "";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  };
  const resolvedTimeZone = timeZone?.trim() || "UTC";

  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: resolvedTimeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: "UTC",
    }).format(date);
  }
}

function formatSettingsDateInput(
  value: Date = new Date(),
  timeZone?: string | null,
): string {
  return formatDateInputForTimeZone(value, timeZone?.trim() || "UTC");
}

function requireSettingsExportData<T>(
  result: { data?: T; error?: { message?: string } | null },
  fallbackMessage: string,
): T {
  if (result.error) {
    throw new Error(result.error.message || fallbackMessage);
  }

  if (result.data === undefined) {
    throw new Error(fallbackMessage);
  }

  return result.data;
}

function SettingsLoadError({
  message,
  title = "Could not load settings",
  onRetry,
}: {
  message: string;
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-1">{message}</p>
          {onRetry ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="mt-3"
            >
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────
export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const { data: session, status } = useSession();
  const { openWelcome } = useWelcome();
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get("tab") as Tab) || "practice";
  const [activeTab, setActiveTab] = useState<Tab>(
    tabs.some((t) => t.id === initialTab) ? initialTab : "practice",
  );

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking settings access...
      </div>
    );
  }

  if (session?.user?.role !== "admin") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="font-heading text-xl font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Only administrators can access practice settings.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold">Settings</h2>
          <p className="text-sm text-muted-foreground">
            Practice configuration and staff management
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          data-tour="settings-guides"
          onClick={openWelcome}
        >
          <Compass className="mr-2 h-4 w-4" />
          Guides
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:gap-8">
        {/* Section nav: horizontal scroll on small screens, vertical on lg+ */}
        <nav className="lg:w-56 lg:shrink-0" aria-label="Settings sections">
          <div className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    activeTab === tab.id
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Tab content */}
        <div className="min-w-0 flex-1">
          {activeTab === "practice" && <PracticeInfoTab />}
          {activeTab === "locations" && <LocationsTab />}
          {activeTab === "staff" && <StaffTab />}
          {activeTab === "appointmentTypes" && <AppointmentTypesTab />}
          {activeTab === "rooms" && <RoomsTab />}
          {activeTab === "services" && <ServicesTab />}
          {activeTab === "data" && <DataTab />}
          {activeTab === "templates" && <TemplatesTab />}
          {activeTab === "wellness" && <WellnessPlansTab />}
          {activeTab === "messaging" && <MessagingTab />}
          {activeTab === "booking" && <BookingTab />}
          {activeTab === "billing" && <BillingTab />}
        </div>
      </div>
    </div>
  );
}

// ── Practice Info ───────────────────────────────────────────
function PracticeInfoTab() {
  const utils = trpc.useUtils();
  const {
    data: practice,
    isLoading,
    error: practiceError,
  } = trpc.settings.getPractice.useQuery();
  const updateMutation = trpc.settings.updatePractice.useMutation({
    onSuccess: () => {
      utils.settings.getPractice.invalidate();
      toast.success("Practice info updated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // Branding mutation invalidates getBranding too so the sidebar logo/accent
  // refresh without a reload.
  const brandingMutation = trpc.settings.updatePractice.useMutation({
    onSuccess: () => {
      utils.settings.getPractice.invalidate();
      utils.settings.getBranding.invalidate();
      toast.success("Branding updated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleLogoUpload = async (file: File) => {
    if (!isImageUploadFileValid(file)) {
      toast.error(IMAGE_UPLOAD_POLICY_MESSAGE);
      return;
    }

    setUploadingLogo(true);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("category", "branding");
      const res = await fetchWithClientTimeout(
        "/api/upload",
        { method: "POST", body },
        CLIENT_UPLOAD_TIMEOUT_MS,
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Upload failed");
      }
      brandingMutation.mutate({ logoUrl: json.url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingLogo(false);
    }
  };

  const [form, setForm] = useState<PracticeInfoForm | null>(null);
  const isOptionalSettingsEmailValid = (email: string) =>
    email.trim().length === 0 ||
    (email.trim().length <= SETTINGS_EMAIL_MAX_LENGTH &&
      isValidEmail(email.trim()));
  const isPracticeInfoFormValid = (practiceForm: PracticeInfoForm) =>
    practiceForm.name.trim().length > 0 &&
    practiceForm.name.trim().length <= PRACTICE_NAME_MAX_LENGTH &&
    practiceForm.address.trim().length <= SETTINGS_ADDRESS_MAX_LENGTH &&
    practiceForm.phone.trim().length <= SETTINGS_PHONE_MAX_LENGTH &&
    isOptionalSettingsEmailValid(practiceForm.email) &&
    practiceForm.website.trim().length <= SETTINGS_WEBSITE_MAX_LENGTH &&
    isSupportedPracticeTimezone(practiceForm.timezone) &&
    SETTINGS_TAX_RATE_PATTERN.test(practiceForm.taxRatePercent.trim()) &&
    practiceForm.vatNumber.trim().length <= SETTINGS_VAT_NUMBER_MAX_LENGTH;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (practiceError) {
    return <SettingsLoadError message={practiceError.message} />;
  }
  if (!practice) {
    return (
      <EmptyState
        icon={Settings}
        title="Practice settings unavailable"
        description="The practice profile could not be found for this account."
      />
    );
  }

  const currentBrandColor =
    (practice.settings as { brandColor?: string } | null)?.brandColor ?? null;

  // Initialize form from the verified practice profile. Nullable profile fields
  // still get editable display defaults, but a missing profile never builds a
  // blank form.
  const current: PracticeInfoForm = form ?? {
    name: practice.name ?? "",
    address: practice.address ?? "",
    phone: practice.phone ?? "",
    email: practice.email ?? "",
    website: practice.website ?? "",
    timezone: practice.timezone ?? "America/New_York",
    country: practice.country ?? "US",
    currency: practice.currency ?? "usd",
    taxRatePercent: practice.taxRatePercent ?? "8.00",
    vatNumber: practice.vatNumber ?? "",
  };

  const handleChange = (field: string, value: string) => {
    setForm({ ...current, [field]: value });
  };

  // Changing country prefills sensible currency/tax/timezone defaults for that
  // region; the admin can still override any of them before saving.
  const handleCountryChange = (country: string) => {
    const d = regionDefaults(country);
    setForm({
      ...current,
      country,
      currency: d.currency,
      taxRatePercent: d.taxRatePercent,
      timezone: d.timezone,
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
        {/* ── Practice details ── */}
        <div className="space-y-6 rounded-lg border border-border bg-card p-6">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Practice details</h3>
            <p className="text-xs text-muted-foreground">
              Your practice name, contact info, and timezone.
            </p>
          </div>
          <div className="grid gap-4">
            <label className="space-y-1.5">
              <span className="text-sm font-medium">Practice Name</span>
              <Input
                maxLength={PRACTICE_NAME_MAX_LENGTH}
                value={current.name}
                onChange={(e) => handleChange("name", e.target.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium">Address</span>
              <Input
                maxLength={SETTINGS_ADDRESS_MAX_LENGTH}
                value={current.address}
                onChange={(e) => handleChange("address", e.target.value)}
              />
            </label>
            <div className="grid grid-cols-2 gap-4">
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Phone</span>
                <Input
                  maxLength={SETTINGS_PHONE_MAX_LENGTH}
                  value={current.phone}
                  onChange={(e) => handleChange("phone", e.target.value)}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Email</span>
                <Input
                  type="email"
                  maxLength={SETTINGS_EMAIL_MAX_LENGTH}
                  value={current.email}
                  onChange={(e) => handleChange("email", e.target.value)}
                />
              </label>
            </div>
            <label className="space-y-1.5">
              <span className="text-sm font-medium">Website</span>
              <Input
                maxLength={SETTINGS_WEBSITE_MAX_LENGTH}
                value={current.website}
                onChange={(e) => handleChange("website", e.target.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium">Timezone</span>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={current.timezone}
                onChange={(e) => handleChange("timezone", e.target.value)}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* ── Region & Tax ── */}
        <div className="space-y-6 rounded-lg border border-border bg-card p-6">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Region &amp; Tax</h3>
            <p className="text-xs text-muted-foreground">
              Controls invoice currency, tax rate, and date formatting. Choosing
              a country prefills the usual defaults — adjust as needed.
            </p>
          </div>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Country</span>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={current.country}
                  onChange={(e) => handleCountryChange(e.target.value)}
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Currency</span>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={current.currency}
                  onChange={(e) => handleChange("currency", e.target.value)}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Tax / VAT rate (%)</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="999.99"
                  value={current.taxRatePercent}
                  onChange={(e) =>
                    handleChange("taxRatePercent", e.target.value)
                  }
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">
                  VAT number (optional)
                </span>
                <Input
                  maxLength={SETTINGS_VAT_NUMBER_MAX_LENGTH}
                  value={current.vatNumber}
                  onChange={(e) => handleChange("vatNumber", e.target.value)}
                />
              </label>
            </div>
          </div>
        </div>

        {/* ── Branding ── */}
        <div className="space-y-6 rounded-lg border border-border bg-card p-6">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Branding</h3>
            <p className="text-xs text-muted-foreground">
              Your logo and accent color appear across OpenVPM. Changes save
              immediately.
            </p>
          </div>
          <div className="grid gap-5">
            {/* Logo */}
            <div className="space-y-2">
              <span className="text-sm font-medium">Logo</span>
              <div className="flex items-center gap-4">
                {practice.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={practice.logoUrl}
                    alt="Practice logo"
                    className="h-14 w-14 rounded-lg border border-border object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
                    <ImageIcon className="h-5 w-5" />
                  </div>
                )}
                <div>
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleLogoUpload(file);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={uploadingLogo || brandingMutation.isPending}
                    onClick={() => logoInputRef.current?.click()}
                  >
                    {uploadingLogo ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="mr-2 h-4 w-4" />
                    )}
                    {practice.logoUrl ? "Replace logo" : "Upload logo"}
                  </Button>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    PNG, JPG, or WebP. Square images work best.
                  </p>
                </div>
              </div>
            </div>

            {/* Accent color */}
            <div className="space-y-2">
              <span className="text-sm font-medium">Accent color</span>
              <AccentColorPicker
                value={currentBrandColor}
                onChange={(c) => brandingMutation.mutate({ brandColor: c })}
                disabled={brandingMutation.isPending}
              />
            </div>
          </div>
        </div>
      </div>

      <Button
        onClick={() => {
          updateMutation.mutate({
            ...current,
            email: current.email.trim() || undefined,
          });
        }}
        disabled={!isPracticeInfoFormValid(current) || updateMutation.isPending}
      >
        {updateMutation.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Save className="mr-2 h-4 w-4" />
        )}
        Save Changes
      </Button>
    </div>
  );
}

// ── Locations ───────────────────────────────────────────────
type LocationForm = {
  name: string;
  address: string;
  phone: string;
  isPrimary: boolean;
};

function LocationsTab() {
  const utils = trpc.useUtils();
  const {
    data: locationList,
    isLoading,
    error: locationsError,
    refetch: refetchLocations,
  } = trpc.settings.listLocations.useQuery();

  const invalidateLocationState = () => {
    utils.settings.listLocations.invalidate();
    utils.messaging.getStatus.invalidate();
    utils.messaging.getInboxStatus.invalidate();
    utils.subscription.get.invalidate();
  };

  const createMutation = trpc.settings.createLocation.useMutation({
    onSuccess: () => {
      invalidateLocationState();
      setShowAdd(false);
      setAddForm({ name: "", address: "", phone: "", isPrimary: false });
      toast.success("Location created");
    },
    onError: (err) => toast.error(err.message),
  });
  const updateMutation = trpc.settings.updateLocation.useMutation({
    onSuccess: () => {
      invalidateLocationState();
      setEditingId(null);
      toast.success("Location updated");
    },
    onError: (err) => toast.error(err.message),
  });
  const setPrimaryMutation = trpc.settings.setPrimaryLocation.useMutation({
    onSuccess: () => {
      invalidateLocationState();
      toast.success("Primary location updated");
    },
    onError: (err) => toast.error(err.message),
  });
  const deleteMutation = trpc.settings.deleteLocation.useMutation({
    onSuccess: () => {
      invalidateLocationState();
      setConfirmDelete(null);
      toast.success("Location retired");
    },
    onError: (err) => toast.error(err.message),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<LocationForm>({
    name: "",
    address: "",
    phone: "",
    isPrimary: false,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<LocationForm>({
    name: "",
    address: "",
    phone: "",
    isPrimary: false,
  });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const locationsMissing = !isLoading && !locationsError && !locationList;
  const activeLocationCount = locationList?.length ?? 0;
  const isLocationFormValid = (form: {
    name: string;
    address: string;
    phone: string;
  }) =>
    form.name.trim().length > 0 &&
    form.name.trim().length <= LOCATION_NAME_MAX_LENGTH &&
    form.phone.trim().length <= SETTINGS_PHONE_MAX_LENGTH &&
    form.address.trim().length <= SETTINGS_ADDRESS_MAX_LENGTH;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (locationsError) {
    return <SettingsLoadError message={locationsError.message} />;
  }
  if (locationsMissing) {
    return (
      <SettingsLoadError
        title="Could not load locations"
        message="The locations request finished without returning data. Try loading it again before editing practice locations."
        onRetry={() => void refetchLocations()}
      />
    );
  }

  const startEditing = (location: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    isPrimary: boolean;
  }) => {
    setEditingId(location.id);
    setEditForm({
      name: location.name,
      address: location.address ?? "",
      phone: location.phone ?? "",
      isPrimary: location.isPrimary,
    });
    setConfirmDelete(null);
  };

  const saveLocation = (id: string) => {
    updateMutation.mutate({
      id,
      name: editForm.name,
      address: editForm.address,
      phone: editForm.phone,
    });
  };

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold">Practice Locations</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Locations power texting setup, room assignment, reminders, and
            hosted billing quantity.
          </p>
        </div>
        <Button
          onClick={() => {
            setShowAdd(!showAdd);
            setEditingId(null);
            setConfirmDelete(null);
          }}
          size="sm"
          className="gap-2"
        >
          <Plus className="h-4 w-4" />
          Add Location
        </Button>
      </div>

      {showAdd ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">New Location</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Input
              placeholder="Location name"
              maxLength={LOCATION_NAME_MAX_LENGTH}
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            />
            <Input
              placeholder="Phone"
              maxLength={SETTINGS_PHONE_MAX_LENGTH}
              value={addForm.phone}
              onChange={(e) =>
                setAddForm({ ...addForm, phone: e.target.value })
              }
            />
            <Input
              placeholder="Address"
              maxLength={SETTINGS_ADDRESS_MAX_LENGTH}
              value={addForm.address}
              onChange={(e) =>
                setAddForm({ ...addForm, address: e.target.value })
              }
              className="sm:col-span-2"
            />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={addForm.isPrimary}
              onChange={(e) =>
                setAddForm({ ...addForm, isPrimary: e.target.checked })
              }
            />
            Make this the primary location
          </label>
          <div className="mt-4 flex gap-2">
            <Button
              size="sm"
              disabled={
                !isLocationFormValid(addForm) || createMutation.isPending
              }
              onClick={() => createMutation.mutate(addForm)}
            >
              {createMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Location</th>
              <th className="px-4 py-3 text-left font-medium">Contact</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {locationList?.map((location) => {
              const isEditing = editingId === location.id;
              const isConfirmingDelete = confirmDelete === location.id;

              return (
                <tr
                  key={location.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-3 align-top">
                    {isEditing ? (
                      <div className="space-y-2">
                        <Input
                          maxLength={LOCATION_NAME_MAX_LENGTH}
                          value={editForm.name}
                          onChange={(e) =>
                            setEditForm({ ...editForm, name: e.target.value })
                          }
                        />
                        <Input
                          value={editForm.address}
                          placeholder="Address"
                          maxLength={SETTINGS_ADDRESS_MAX_LENGTH}
                          onChange={(e) =>
                            setEditForm({
                              ...editForm,
                              address: e.target.value,
                            })
                          }
                        />
                      </div>
                    ) : (
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{location.name}</span>
                          {location.isPrimary ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                              <Star className="h-3 w-3" />
                              Primary
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          {location.address || "No address on file"}
                        </p>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-muted-foreground">
                    {isEditing ? (
                      <Input
                        value={editForm.phone}
                        placeholder="Phone"
                        maxLength={SETTINGS_PHONE_MAX_LENGTH}
                        onChange={(e) =>
                          setEditForm({ ...editForm, phone: e.target.value })
                        }
                      />
                    ) : (
                      location.phone || "No phone"
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex justify-end gap-1">
                      {isEditing ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              !isLocationFormValid(editForm) ||
                              updateMutation.isPending
                            }
                            onClick={() => saveLocation(location.id)}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingId(null)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </>
                      ) : (
                        <>
                          {!location.isPrimary ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={setPrimaryMutation.isPending}
                              onClick={() =>
                                setPrimaryMutation.mutate({ id: location.id })
                              }
                            >
                              <Star className="h-4 w-4" />
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => startEditing(location)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {isConfirmingDelete ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={
                                deleteMutation.isPending ||
                                activeLocationCount <= 1
                              }
                              onClick={() =>
                                deleteMutation.mutate({ id: location.id })
                              }
                            >
                              <Check className="h-4 w-4 text-destructive" />
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={activeLocationCount <= 1}
                              onClick={() => setConfirmDelete(location.id)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {locationList?.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent p-8"
                    icon={MapPin}
                    title="No active locations configured"
                    description="Add a location to power rooms, reminders, texting setup, and hosted billing quantities."
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {activeLocationCount <= 1 ? (
        <p className="text-xs text-muted-foreground">
          A practice must keep at least one active location.
        </p>
      ) : null}
    </div>
  );
}

// ── Plan & Billing ──────────────────────────────────────────
const FEATURE_LABELS: Record<string, string> = {
  agent: "OpenVPM Agent (AI)",
  sms: "SMS sending",
  advancedReporting: "Advanced reporting",
  apiAccess: "API access + webhooks",
  multiLocation: "Multi-location",
  integrations: "Supported integrations",
};

function redirectToHostedBillingUrl(url: unknown) {
  if (!isSafeCheckoutRedirectUrl(url)) {
    toast.error("Billing checkout is unavailable. Please try again.");
    return;
  }

  window.location.href = url;
}

function redirectToClientPaymentUrl(url: unknown) {
  if (!isSafeCheckoutRedirectUrl(url)) {
    toast.error("Client payment setup is unavailable. Please try again.");
    return;
  }

  window.location.href = url;
}

function BillingTab() {
  const utils = trpc.useUtils();
  const [showAllPlans, setShowAllPlans] = useState(false);
  const {
    data,
    isLoading,
    error: billingError,
    refetch: refetchBilling,
  } = trpc.subscription.get.useQuery();
  const paymentAccount = trpc.billing.paymentAccountStatus.useQuery(undefined, {
    staleTime: 60_000,
  });
  const checkout = trpc.subscription.createCheckout.useMutation({
    onSuccess: (r) => {
      redirectToHostedBillingUrl(r.url);
    },
    onError: (e) => toast.error(e.message),
  });
  const setupPaymentAccount =
    trpc.billing.createPaymentAccountOnboarding.useMutation({
      onSuccess: (r) => {
        redirectToClientPaymentUrl(r.url);
      },
      onError: (e) => toast.error(e.message),
    });
  const refreshPaymentAccount = trpc.billing.refreshPaymentAccount.useMutation({
    onSuccess: () => {
      utils.billing.paymentAccountStatus.invalidate();
      toast.success("Client payment status refreshed");
    },
    onError: (e) => toast.error(e.message),
  });
  const openPaymentAccountDashboard =
    trpc.billing.openPaymentAccountDashboard.useMutation({
      onSuccess: (r) => {
        redirectToClientPaymentUrl(r.url);
      },
      onError: (e) => toast.error(e.message),
    });
  const portal = trpc.subscription.openBillingPortal.useMutation({
    onSuccess: (r) => {
      redirectToHostedBillingUrl(r.url);
    },
    onError: (e) => toast.error(e.message),
  });

  if (billingError) {
    return (
      <SettingsLoadError
        title="Could not load billing details"
        message={billingError.message}
        onRetry={() => void refetchBilling()}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <SettingsLoadError
        title="Could not load billing details"
        message="The billing details request finished without returning data. Try loading it again."
        onRetry={() => void refetchBilling()}
      />
    );
  }

  // Self-host: nothing to buy — everything is unlocked.
  if (!data.billingEnforced) {
    return (
      <div className="space-y-6">
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-6">
            <div className="flex items-center gap-3">
              <Check className="h-5 w-5 text-green-600" />
              <h3 className="font-heading text-lg font-semibold">
                Self-hosted — all features unlocked
              </h3>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              You&apos;re running OpenVPM on your own infrastructure. Every
              feature is available and there&apos;s no subscription — free
              forever. Plans below are how the managed OpenVPM Cloud is priced,
              for reference.
            </p>
          </div>
          <ClientPaymentProcessingSection
            data={paymentAccount.data}
            isLoading={paymentAccount.isLoading}
            error={paymentAccount.error?.message}
            setupPending={setupPaymentAccount.isPending}
            refreshPending={refreshPaymentAccount.isPending}
            dashboardPending={openPaymentAccountDashboard.isPending}
            onSetup={() => setupPaymentAccount.mutate()}
            onRefresh={() => refreshPaymentAccount.mutate()}
            onDashboard={() => openPaymentAccountDashboard.mutate()}
          />
        </div>
        <PlanGrid
          plans={data.plans}
          currentTier={data.tier}
          enforced={false}
          onChoose={() => {}}
          busyTier={null}
        />
      </div>
    );
  }

  const daysLeft = trialCalendarDaysLeft(data.trialEndsAt, data.timezone) ?? 0;
  const currentPlan = data.plans.find((p) => p.tier === data.tier);
  const showReadOnlyNotice = !data.hasFullAccess;
  const perLocation = data.locationUnitPriceMonthlyUsd;
  const multiLocation = data.locationCount > 1;
  const priceSentence = multiLocation
    ? `$${perLocation} a month for each of your ${data.locationCount} locations (about $${data.estimatedMonthlyBase} a month)`
    : `$${perLocation} a month for your location`;
  // Only surface the sync note when something actually needs attention.
  const showSyncNote =
    data.billingSyncStatus &&
    (data.billingSyncStatus.status === "error" ||
      data.billingSyncStatus.status === "legacy");

  return (
    <div className="space-y-6">
      {/* One clear plan card: what you have, what it costs, what is included. */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Your plan</p>
            <div className="flex items-center gap-3">
              <h3 className="font-heading text-2xl font-semibold">
                {currentPlan?.name ?? data.tier}
              </h3>
              <span
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium capitalize",
                  data.billingStatus === "active" &&
                    "bg-green-100 text-green-700",
                  data.billingStatus === "trialing" &&
                    "bg-blue-100 text-blue-700",
                  data.billingStatus === "past_due" &&
                    "bg-red-100 text-red-700",
                  (data.billingStatus === "canceled" ||
                    data.billingStatus === "none") &&
                    "bg-gray-100 text-gray-600",
                )}
              >
                {data.billingStatus === "trialing"
                  ? `Trial · ${daysLeft} days left`
                  : data.billingStatus.replace("_", " ")}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.hasSubscription || data.hasBillingAccount ? (
              <Button
                variant="outline"
                disabled={portal.isPending}
                onClick={() => portal.mutate()}
              >
                {portal.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CreditCard className="mr-2 h-4 w-4" />
                )}
                Manage billing
              </Button>
            ) : (
              <Button
                disabled={checkout.isPending}
                onClick={() => checkout.mutate({ tier: "cloud" })}
              >
                {checkout.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CreditCard className="mr-2 h-4 w-4" />
                )}
                Subscribe
              </Button>
            )}
          </div>
        </div>

        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          {data.billingStatus === "trialing" ? (
            <>
              Your free trial has{" "}
              <span className="font-medium text-foreground">
                {daysLeft} days
              </span>{" "}
              left. After that, {currentPlan?.name ?? "Cloud"} is{" "}
              {priceSentence}. Unlimited staff, and everything you see today
              stays on.
            </>
          ) : (
            <>
              {currentPlan?.name ?? "Cloud"} is {priceSentence}. Unlimited
              staff, everything included.
            </>
          )}
        </p>

        {(currentPlan?.includedSmsPerMonth != null ||
          currentPlan?.includedAiRunsPerMonth != null) && (
          <p className="mt-2 text-sm text-muted-foreground">
            This month:{" "}
            <span className="font-medium text-foreground">
              {data.usage.sms}
            </span>{" "}
            of {currentPlan?.includedSmsPerMonth?.toLocaleString()} included
            texts ·{" "}
            <span className="font-medium text-foreground">
              {data.usage.aiRuns}
            </span>{" "}
            of {currentPlan?.includedAiRunsPerMonth?.toLocaleString()} included
            AI actions
          </p>
        )}

        {showReadOnlyNotice && (
          <div className="mt-4 flex gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Cloud is in read-only mode. You can view records, manage billing,
              and export data; writes resume when your trial or subscription is
              active.
            </p>
          </div>
        )}
        {data.billingStatus === "past_due" && (
          <p className="mt-3 text-sm text-red-600">
            Your last payment failed. Update your payment method to restore
            write access.
          </p>
        )}
        {showSyncNote && (
          <div
            className={cn(
              "mt-4 rounded-md border p-3 text-xs",
              data.billingSyncStatus!.status === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-amber-200 bg-amber-50 text-amber-800",
            )}
          >
            <span className="font-medium">Billing sync: </span>
            {data.billingSyncStatus!.message}
          </div>
        )}
      </div>

      <ClientPaymentProcessingSection
        data={paymentAccount.data}
        isLoading={paymentAccount.isLoading}
        error={paymentAccount.error?.message}
        setupPending={setupPaymentAccount.isPending}
        refreshPending={refreshPaymentAccount.isPending}
        dashboardPending={openPaymentAccountDashboard.isPending}
        onSetup={() => setupPaymentAccount.mutate()}
        onRefresh={() => refreshPaymentAccount.mutate()}
        onDashboard={() => openPaymentAccountDashboard.mutate()}
      />

      {/* Plan comparison is reference material, collapsed by default. */}
      <div>
        <button
          type="button"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => setShowAllPlans((v) => !v)}
        >
          {showAllPlans ? "Hide plan comparison" : "Compare all plans"}
        </button>
        {showAllPlans && (
          <div className="mt-4">
            <PlanGrid
              plans={data.plans}
              currentTier={data.tier}
              enforced
              onChoose={(tier) => checkout.mutate({ tier })}
              busyTier={
                checkout.isPending ? (checkout.variables?.tier ?? null) : null
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ClientPaymentProcessingSection({
  data,
  isLoading,
  error,
  setupPending,
  refreshPending,
  dashboardPending,
  onSetup,
  onRefresh,
  onDashboard,
}: {
  data:
    | {
        stripeConfigured: boolean;
        connectRequired: boolean;
        status:
          | "not_started"
          | "pending"
          | "active"
          | "action_required"
          | "disabled"
          | "not_configured"
          | "not_required";
        enabled: boolean;
        chargesEnabled?: boolean;
        payoutsEnabled?: boolean;
        detailsSubmitted?: boolean;
        requirementsCurrentlyDue?: string[];
        requirementsDisabledReason?: string | null;
        lastSyncedAt?: Date | string | null;
      }
    | undefined;
  isLoading: boolean;
  error?: string;
  setupPending: boolean;
  refreshPending: boolean;
  dashboardPending: boolean;
  onSetup: () => void;
  onRefresh: () => void;
  onDashboard: () => void;
}) {
  const status = data?.enabled
    ? "ready"
    : data?.status === "action_required" || data?.status === "disabled"
      ? "action required"
      : data?.connectRequired
        ? "setup needed"
        : data?.stripeConfigured
          ? "configured"
          : "not configured";
  const statusClass = data?.enabled
    ? "bg-green-100 text-green-700"
    : data?.status === "action_required" || data?.status === "disabled"
      ? "bg-amber-100 text-amber-800"
      : data?.stripeConfigured
        ? "bg-blue-100 text-blue-700"
        : "bg-gray-100 text-gray-600";
  const canOpenDashboard = Boolean(
    data?.connectRequired && data.status !== "not_started",
  );
  const canShowSetup =
    Boolean(data?.connectRequired && data.stripeConfigured) &&
    data?.status !== "active";

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-lg font-semibold">
              Client payment processing
            </h3>
            <span
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium capitalize",
                statusClass,
              )}
            >
              {status}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {data?.connectRequired
              ? "Stripe Connect lets the clinic collect card payments from pet owners into its own Stripe account."
              : "This installation can use its configured Stripe key for client invoice payments. Stripe Connect is required for hosted OpenVPM Cloud clinics."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canShowSetup && (
            <Button size="sm" disabled={setupPending} onClick={onSetup}>
              {setupPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CreditCard className="mr-2 h-4 w-4" />
              )}
              {data?.status === "not_started" ? "Set up" : "Resume setup"}
            </Button>
          )}
          {data?.connectRequired && (
            <Button
              size="sm"
              variant="outline"
              disabled={refreshPending || !data.stripeConfigured}
              onClick={onRefresh}
            >
              {refreshPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Refresh
            </Button>
          )}
          {canOpenDashboard && (
            <Button
              size="sm"
              variant="outline"
              disabled={dashboardPending}
              onClick={onDashboard}
            >
              {dashboardPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CreditCard className="mr-2 h-4 w-4" />
              )}
              Open Stripe
            </Button>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading client payment status
        </div>
      )}
      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      {!isLoading && !error && data && (
        <div className="mt-4 grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-muted-foreground">Stripe API</p>
            <p className="font-medium">
              {data.stripeConfigured ? "Configured" : "Missing"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Card payments</p>
            <p className="font-medium">
              {data.enabled || data.status === "not_required"
                ? "Enabled"
                : "Disabled"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Payouts</p>
            <p className="font-medium">
              {data.payoutsEnabled
                ? "Enabled"
                : data.connectRequired
                  ? "Pending"
                  : "N/A"}
            </p>
          </div>
          {data.requirementsCurrentlyDue?.length ? (
            <div className="sm:col-span-3">
              <p className="text-muted-foreground">Stripe requirements</p>
              <p className="font-medium">
                {data.requirementsCurrentlyDue.length} item
                {data.requirementsCurrentlyDue.length === 1 ? "" : "s"} due
              </p>
            </div>
          ) : null}
          {data.requirementsDisabledReason ? (
            <div className="sm:col-span-3">
              <p className="text-muted-foreground">Disabled reason</p>
              <p className="font-medium">{data.requirementsDisabledReason}</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PlanGrid({
  plans,
  currentTier,
  enforced,
  onChoose,
  busyTier,
}: {
  plans: Array<{
    tier: string;
    name: string;
    locationUnitPriceMonthlyUsd: number | null;
    seatUnitPriceMonthlyUsd: number | null;
    blurb: string;
    features: string[];
    seatLimit: number | null;
    locationLimit: number | null;
    includedSmsPerMonth: number | null;
    includedAiRunsPerMonth: number | null;
    aiOveragePriceUsd: number | null;
    smsOveragePriceUsd: number | null;
    selfServe: boolean;
    purchasable: boolean;
  }>;
  currentTier: string;
  enforced: boolean;
  onChoose: (tier: "cloud") => void;
  busyTier: string | null;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {plans.map((p) => {
        const isCurrent = p.tier === currentTier;
        const canBuy =
          enforced && p.purchasable && p.tier === "cloud" && !isCurrent;
        return (
          <div
            key={p.tier}
            className={cn(
              "flex flex-col rounded-lg border bg-card p-5",
              isCurrent
                ? "border-primary ring-1 ring-primary"
                : "border-border",
            )}
          >
            <h4 className="font-heading text-base font-semibold">{p.name}</h4>
            <p className="mt-1 text-2xl font-bold">
              {p.locationUnitPriceMonthlyUsd === null ? (
                "Custom"
              ) : p.locationUnitPriceMonthlyUsd === 0 ? (
                "Free"
              ) : (
                <>
                  ${p.locationUnitPriceMonthlyUsd}
                  <span className="text-sm font-normal text-muted-foreground">
                    /location
                  </span>
                  <span className="block text-sm font-normal text-muted-foreground">
                    {p.seatUnitPriceMonthlyUsd && p.seatUnitPriceMonthlyUsd > 0
                      ? `+ $${p.seatUnitPriceMonthlyUsd}/staff/mo`
                      : "unlimited staff"}
                  </span>
                </>
              )}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">{p.blurb}</p>
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
              <li>
                {p.seatLimit === null ? "All" : p.seatLimit} staff roles
                included
              </li>
              <li>
                {p.locationLimit === null ? "Unlimited" : p.locationLimit}{" "}
                location
                {p.locationLimit === 1 ? "" : "s"}
              </li>
              {p.includedSmsPerMonth ? (
                <li>
                  {p.includedSmsPerMonth.toLocaleString()} SMS/mo included
                  {p.smsOveragePriceUsd
                    ? `, then $${p.smsOveragePriceUsd}/SMS`
                    : ""}
                </li>
              ) : null}
              {p.includedAiRunsPerMonth ? (
                <li>
                  {p.includedAiRunsPerMonth.toLocaleString()} AI actions/mo
                  included
                  {p.aiOveragePriceUsd
                    ? `, then $${p.aiOveragePriceUsd}/action`
                    : ""}
                </li>
              ) : null}
              {p.features.length > 0 ? (
                p.features.map((f) => (
                  <li key={f} className="flex items-center gap-1">
                    <Check className="h-3 w-3 text-green-600" />
                    {FEATURE_LABELS[f] ?? f}
                  </li>
                ))
              ) : (
                <li>Full core PIMS</li>
              )}
            </ul>
            <div className="mt-4 pt-2">
              {isCurrent ? (
                <span className="text-xs font-medium text-primary">
                  Current plan
                </span>
              ) : canBuy ? (
                <Button
                  size="sm"
                  className="w-full"
                  disabled={busyTier === p.tier}
                  onClick={() => onChoose(p.tier as "cloud")}
                >
                  {busyTier === p.tier ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Choose {p.name}
                </Button>
              ) : !p.selfServe ? (
                <a
                  href="mailto:support@openvpm.com?subject=OpenVPM%20Enterprise"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Contact sales
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Staff ───────────────────────────────────────────────────
function StaffTab() {
  const utils = trpc.useUtils();
  const {
    data: staffList,
    isLoading,
    error: staffError,
    refetch: refetchStaff,
  } = trpc.settings.listUsers.useQuery();
  const createMutation = trpc.settings.createUser.useMutation({
    onSuccess: () => {
      utils.settings.listUsers.invalidate();
      setShowAdd(false);
      resetAddForm();
      toast.success("Staff member added");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const updateMutation = trpc.settings.updateUser.useMutation({
    onSuccess: () => {
      utils.settings.listUsers.invalidate();
      setEditingId(null);
      toast.success("Staff member updated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const deactivateMutation = trpc.settings.deactivateUser.useMutation({
    onSuccess: () => {
      utils.settings.listUsers.invalidate();
      toast.success("Staff member deactivated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const inviteMutation = trpc.settings.inviteStaff.useMutation({
    onSuccess: (res) => {
      utils.settings.listUsers.invalidate();
      setInviteForm({ email: "", name: "", role: "front_desk" });
      setInviteUrl(res.inviteUrl ?? null);
      toast.success("Invite sent");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    email: "",
    name: "",
    role: "front_desk" as
      | "admin"
      | "veterinarian"
      | "technician"
      | "front_desk"
      | "viewer",
  });
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "front_desk" as const,
    phone: "",
    licenseNumber: "",
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    role: "front_desk" as
      | "admin"
      | "veterinarian"
      | "technician"
      | "front_desk"
      | "viewer",
    phone: "",
    licenseNumber: "",
  });
  const [confirmDeactivate, setConfirmDeactivate] = useState<string | null>(
    null,
  );

  const resetAddForm = () =>
    setAddForm({
      name: "",
      email: "",
      password: "",
      role: "front_desk",
      phone: "",
      licenseNumber: "",
    });
  const isStaffNameValid = (name: string) =>
    name.trim().length > 0 && name.trim().length <= STAFF_NAME_MAX_LENGTH;
  const isOptionalStaffNameValid = (name: string) =>
    name.trim().length <= STAFF_NAME_MAX_LENGTH;
  const isSettingsEmailInputValid = (email: string) =>
    email.trim().length <= SETTINGS_EMAIL_MAX_LENGTH &&
    isValidEmail(email.trim());
  const isStaffContactFieldsValid = (form: {
    phone: string;
    licenseNumber: string;
  }) =>
    form.phone.trim().length <= SETTINGS_PHONE_MAX_LENGTH &&
    form.licenseNumber.trim().length <= STAFF_LICENSE_NUMBER_MAX_LENGTH;
  const isStaffPasswordValid = (password: string) =>
    password.length >= AUTH_PASSWORD_MIN_LENGTH &&
    password.length <= AUTH_PASSWORD_MAX_LENGTH;
  const isStaffCreateFormValid = (form: typeof addForm) =>
    isStaffNameValid(form.name) &&
    isSettingsEmailInputValid(form.email) &&
    isStaffPasswordValid(form.password) &&
    isStaffContactFieldsValid(form);
  const isStaffInviteFormValid = (form: typeof inviteForm) =>
    isSettingsEmailInputValid(form.email) &&
    isOptionalStaffNameValid(form.name);
  const isStaffEditFormValid = (form: typeof editForm) =>
    isStaffNameValid(form.name) && isStaffContactFieldsValid(form);
  const staffMissing = !isLoading && !staffError && !staffList;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (staffError) {
    return <SettingsLoadError message={staffError.message} />;
  }
  if (staffMissing) {
    return (
      <SettingsLoadError
        title="Could not load staff"
        message="The staff list request finished without returning data. Try loading it again before adding or editing staff."
        onRetry={() => void refetchStaff()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button
          onClick={() => {
            setShowInvite(!showInvite);
            setShowAdd(false);
            setInviteUrl(null);
          }}
          size="sm"
          variant="outline"
        >
          <Mail className="mr-2 h-4 w-4" />
          Invite by email
        </Button>
        <Button
          onClick={() => {
            setShowAdd(!showAdd);
            setShowInvite(false);
            resetAddForm();
          }}
          size="sm"
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Staff
        </Button>
      </div>

      {showInvite && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">Invite a teammate</h3>
          <p className="text-xs text-muted-foreground">
            They&apos;ll get an email to set their own password and activate
            their account.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Email"
              type="email"
              maxLength={SETTINGS_EMAIL_MAX_LENGTH}
              value={inviteForm.email}
              onChange={(e) =>
                setInviteForm({ ...inviteForm, email: e.target.value })
              }
            />
            <Input
              placeholder="Name (optional)"
              maxLength={STAFF_NAME_MAX_LENGTH}
              value={inviteForm.name}
              onChange={(e) =>
                setInviteForm({ ...inviteForm, name: e.target.value })
              }
            />
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={inviteForm.role}
              onChange={(e) =>
                setInviteForm({
                  ...inviteForm,
                  role: e.target.value as typeof inviteForm.role,
                })
              }
            >
              <option value="front_desk">Front Desk</option>
              <option value="viewer">Viewer (read-only)</option>
              <option value="technician">Technician</option>
              <option value="veterinarian">Veterinarian</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                !isStaffInviteFormValid(inviteForm) || inviteMutation.isPending
              }
              onClick={() =>
                inviteMutation.mutate({
                  email: inviteForm.email,
                  name: inviteForm.name || undefined,
                  role: inviteForm.role,
                })
              }
            >
              {inviteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Send invite
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowInvite(false)}
            >
              Cancel
            </Button>
          </div>
          {inviteUrl && (
            <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs font-medium text-muted-foreground">
                Invite link (shown in dev/preview so you can test the flow):
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">
                  {inviteUrl}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(inviteUrl);
                    toast.success("Copied");
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
          {inviteMutation.error && (
            <p className="text-sm text-destructive">
              {inviteMutation.error.message}
            </p>
          )}
        </div>
      )}

      {showAdd && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">New Staff Member</h3>
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Full name"
              maxLength={STAFF_NAME_MAX_LENGTH}
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            />
            <Input
              placeholder="Email"
              type="email"
              maxLength={SETTINGS_EMAIL_MAX_LENGTH}
              value={addForm.email}
              onChange={(e) =>
                setAddForm({ ...addForm, email: e.target.value })
              }
            />
            <Input
              placeholder={`Password (min ${AUTH_PASSWORD_MIN_LENGTH} chars)`}
              type="password"
              maxLength={AUTH_PASSWORD_MAX_LENGTH}
              value={addForm.password}
              onChange={(e) =>
                setAddForm({ ...addForm, password: e.target.value })
              }
            />
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={addForm.role}
              onChange={(e) =>
                setAddForm({
                  ...addForm,
                  role: e.target.value as typeof addForm.role,
                })
              }
            >
              <option value="front_desk">Front Desk</option>
              <option value="viewer">Viewer (read-only)</option>
              <option value="technician">Technician</option>
              <option value="veterinarian">Veterinarian</option>
              <option value="admin">Admin</option>
            </select>
            <Input
              placeholder="Phone (optional)"
              maxLength={SETTINGS_PHONE_MAX_LENGTH}
              value={addForm.phone}
              onChange={(e) =>
                setAddForm({ ...addForm, phone: e.target.value })
              }
            />
            <Input
              placeholder="License # (optional)"
              maxLength={STAFF_LICENSE_NUMBER_MAX_LENGTH}
              value={addForm.licenseNumber}
              onChange={(e) =>
                setAddForm({ ...addForm, licenseNumber: e.target.value })
              }
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                !isStaffCreateFormValid(addForm) || createMutation.isPending
              }
              onClick={() =>
                createMutation.mutate({
                  ...addForm,
                  phone: addForm.phone || undefined,
                  licenseNumber: addForm.licenseNumber || undefined,
                })
              }
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
          </div>
          {createMutation.error && (
            <p className="text-sm text-destructive">
              {createMutation.error.message}
            </p>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Email</th>
              <th className="px-4 py-3 text-left font-medium">Role</th>
              <th className="px-4 py-3 text-left font-medium">Phone</th>
              <th className="px-4 py-3 text-left font-medium">License #</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {staffList?.map((user) => (
              <tr
                key={user.id}
                className="border-b border-border last:border-0"
              >
                {editingId === user.id ? (
                  <>
                    <td className="px-4 py-2">
                      <Input
                        className="h-8"
                        maxLength={STAFF_NAME_MAX_LENGTH}
                        value={editForm.name}
                        onChange={(e) =>
                          setEditForm({ ...editForm, name: e.target.value })
                        }
                      />
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {user.email}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                        value={editForm.role}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            role: e.target.value as typeof editForm.role,
                          })
                        }
                      >
                        <option value="front_desk">Front Desk</option>
                        <option value="viewer">Viewer (read-only)</option>
                        <option value="technician">Technician</option>
                        <option value="veterinarian">Veterinarian</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        className="h-8"
                        maxLength={SETTINGS_PHONE_MAX_LENGTH}
                        value={editForm.phone}
                        onChange={(e) =>
                          setEditForm({ ...editForm, phone: e.target.value })
                        }
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        className="h-8"
                        maxLength={STAFF_LICENSE_NUMBER_MAX_LENGTH}
                        value={editForm.licenseNumber}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            licenseNumber: e.target.value,
                          })
                        }
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            !isStaffEditFormValid(editForm) ||
                            updateMutation.isPending
                          }
                          onClick={() =>
                            updateMutation.mutate({
                              id: user.id,
                              name: editForm.name,
                              role: editForm.role,
                              phone: editForm.phone || undefined,
                              licenseNumber:
                                editForm.licenseNumber || undefined,
                            })
                          }
                        >
                          <Save className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 font-medium">{user.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {user.email}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                          ROLE_BADGE[user.role] ?? ROLE_BADGE.front_desk,
                        )}
                      >
                        {user.role.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {user.phone ?? "-"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {user.licenseNumber ?? "-"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {confirmDeactivate === user.id ? (
                        <div className="flex items-center justify-end gap-1">
                          <span className="mr-2 text-xs text-destructive">
                            Deactivate?
                          </span>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={deactivateMutation.isPending}
                            onClick={() => {
                              deactivateMutation.mutate({ id: user.id });
                              setConfirmDeactivate(null);
                            }}
                          >
                            Yes
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDeactivate(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditingId(user.id);
                              setEditForm({
                                name: user.name,
                                role: user.role,
                                phone: user.phone ?? "",
                                licenseNumber: user.licenseNumber ?? "",
                              });
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDeactivate(user.id)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
            {staffList?.length === 0 && (
              <tr>
                <td colSpan={6} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent p-8"
                    icon={Users}
                    title="No staff members found"
                    description="Invite teammates or create a staff login to finish practice setup."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Appointment Types ───────────────────────────────────────
function AppointmentTypesTab() {
  const utils = trpc.useUtils();
  const {
    data: types,
    isLoading,
    error: appointmentTypesError,
    refetch: refetchAppointmentTypes,
  } = trpc.settings.listAppointmentTypes.useQuery();
  const createMutation = trpc.settings.createAppointmentType.useMutation({
    onSuccess: () => {
      utils.settings.listAppointmentTypes.invalidate();
      setShowAdd(false);
      resetAddForm();
      toast.success("Appointment type created");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const updateMutation = trpc.settings.updateAppointmentType.useMutation({
    onSuccess: () => {
      utils.settings.listAppointmentTypes.invalidate();
      setEditingId(null);
      toast.success("Appointment type updated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const deleteMutation = trpc.settings.deleteAppointmentType.useMutation({
    onSuccess: () => {
      utils.settings.listAppointmentTypes.invalidate();
      toast.success("Appointment type deleted");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    durationMinutes: 30,
    color: "#0d9488",
    requiresDoctor: 1,
    defaultRoomType: "exam" as "exam" | "surgery" | "treatment" | "boarding",
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ ...addForm });
  const isDurationValid = (duration: number) =>
    Number.isInteger(duration) &&
    duration >= APPOINTMENT_TYPE_DURATION_MIN_MINUTES &&
    duration <= APPOINTMENT_TYPE_DURATION_MAX_MINUTES;
  const isAppointmentTypeNameValid = (name: string) =>
    name.trim().length > 0 &&
    name.trim().length <= APPOINTMENT_TYPE_NAME_MAX_LENGTH;

  const resetAddForm = () =>
    setAddForm({
      name: "",
      durationMinutes: 30,
      color: "#0d9488",
      requiresDoctor: 1,
      defaultRoomType: "exam",
    });
  const appointmentTypesMissing =
    !isLoading && !appointmentTypesError && !types;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (appointmentTypesError) {
    return <SettingsLoadError message={appointmentTypesError.message} />;
  }
  if (appointmentTypesMissing) {
    return (
      <SettingsLoadError
        title="Could not load appointment types"
        message="The appointment type request finished without returning data. Try loading it again before editing scheduling defaults."
        onRetry={() => void refetchAppointmentTypes()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setShowAdd(!showAdd);
            resetAddForm();
          }}
          size="sm"
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Type
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">New Appointment Type</h3>
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Type name"
              maxLength={APPOINTMENT_TYPE_NAME_MAX_LENGTH}
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            />
            <Input
              type="number"
              placeholder="Duration (minutes)"
              min={APPOINTMENT_TYPE_DURATION_MIN_MINUTES}
              max={APPOINTMENT_TYPE_DURATION_MAX_MINUTES}
              value={addForm.durationMinutes}
              onChange={(e) =>
                setAddForm({
                  ...addForm,
                  durationMinutes: parseInt(e.target.value) || 30,
                })
              }
            />
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Color</span>
              <div className="flex gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    className={cn(
                      "h-8 w-8 rounded-full border-2 transition-transform",
                      addForm.color === c
                        ? "border-foreground scale-110"
                        : "border-transparent",
                    )}
                    style={{ backgroundColor: c }}
                    onClick={() => setAddForm({ ...addForm, color: c })}
                  />
                ))}
              </div>
            </div>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={addForm.defaultRoomType}
              onChange={(e) =>
                setAddForm({
                  ...addForm,
                  defaultRoomType: e.target
                    .value as typeof addForm.defaultRoomType,
                })
              }
            >
              {ROOM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                !isAppointmentTypeNameValid(addForm.name) ||
                !isDurationValid(addForm.durationMinutes) ||
                createMutation.isPending
              }
              onClick={() => createMutation.mutate(addForm)}
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Duration</th>
              <th className="px-4 py-3 text-left font-medium">Color</th>
              <th className="px-4 py-3 text-left font-medium">Room Type</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {types?.map((type) => (
              <tr
                key={type.id}
                className="border-b border-border last:border-0"
              >
                {editingId === type.id ? (
                  <>
                    <td className="px-4 py-2">
                      <Input
                        className="h-8"
                        maxLength={APPOINTMENT_TYPE_NAME_MAX_LENGTH}
                        value={editForm.name}
                        onChange={(e) =>
                          setEditForm({ ...editForm, name: e.target.value })
                        }
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        className="h-8 w-20"
                        type="number"
                        min={APPOINTMENT_TYPE_DURATION_MIN_MINUTES}
                        max={APPOINTMENT_TYPE_DURATION_MAX_MINUTES}
                        value={editForm.durationMinutes}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            durationMinutes: parseInt(e.target.value) || 30,
                          })
                        }
                      />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        {PRESET_COLORS.map((c) => (
                          <button
                            key={c}
                            className={cn(
                              "h-6 w-6 rounded-full border-2",
                              editForm.color === c
                                ? "border-foreground"
                                : "border-transparent",
                            )}
                            style={{ backgroundColor: c }}
                            onClick={() =>
                              setEditForm({ ...editForm, color: c })
                            }
                          />
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                        value={editForm.defaultRoomType}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            defaultRoomType: e.target
                              .value as typeof editForm.defaultRoomType,
                          })
                        }
                      >
                        {ROOM_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            !isAppointmentTypeNameValid(editForm.name) ||
                            !isDurationValid(editForm.durationMinutes) ||
                            updateMutation.isPending
                          }
                          onClick={() =>
                            updateMutation.mutate({
                              id: type.id,
                              ...editForm,
                            })
                          }
                        >
                          <Save className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 font-medium">{type.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {type.durationMinutes} min
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-block h-4 w-4 rounded-full"
                        style={{ backgroundColor: type.color ?? "#6b7280" }}
                      />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground capitalize">
                      {type.defaultRoomType ?? "-"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(type.id);
                            setEditForm({
                              name: type.name,
                              durationMinutes: type.durationMinutes,
                              color: type.color ?? "#0d9488",
                              requiresDoctor: type.requiresDoctor,
                              defaultRoomType: type.defaultRoomType ?? "exam",
                            });
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => deleteMutation.mutate({ id: type.id })}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {types?.length === 0 && (
              <tr>
                <td colSpan={5} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent p-8"
                    icon={Calendar}
                    title="No appointment types configured"
                    description="Add appointment types so scheduling can use default durations, colors, and room types."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── CSV Helpers ──────────────────────────────────────────────
function downloadCSV(data: Record<string, unknown>[], filename: string) {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]);
  const csv = [
    headers.join(","),
    ...data.map((row) =>
      headers
        .map((h) => {
          const val = String(row[h] ?? "");
          return val.includes(",") || val.includes('"')
            ? `"${val.replace(/"/g, '""')}"`
            : val;
        })
        .join(","),
    ),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJSON(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type ImportPreview = {
  requestKey: string;
  previewToken: string;
  total: number;
  willInsert: number;
  willReconcile?: number;
  duplicates?: number;
  unmatchedClient?: number;
  unmatchedPatient?: number;
  errors: string[];
};
type ImportMode = MigrationImportMode;
const IMPORT_CSV_SIZE_MESSAGE = "CSV imports must be 5 MB or less.";
function importPreviewRequestKey(
  mode: ImportMode,
  source: string,
  csv: string,
): string {
  let hash = 2_166_136_261;
  const input = `${mode}\u0000${source}\u0000${csv}`;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${mode}:${source}:${csv.length}:${(hash >>> 0).toString(16)}`;
}
// ── Data Tab ─────────────────────────────────────────────────
function DataTab() {
  const [exportingType, setExportingType] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<ImportMode | null>(null);
  const [migrationSource, setMigrationSource] = useState<
    (typeof MIGRATION_SOURCES)[number]["id"] | null
  >(null);
  const importSource = migrationSource ?? "other";
  const [csvText, setCsvText] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(
    null,
  );
  const [importResult, setImportResult] = useState<{
    imported: number;
    reconciled?: number;
    errors?: string[];
  } | null>(null);
  const [importRecoveryMessage, setImportRecoveryMessage] = useState("");
  const [backupFileName, setBackupFileName] = useState("");
  const [backupPayload, setBackupPayload] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [backupSummary, setBackupSummary] = useState<{
    counts: Record<string, number>;
    missingSections: string[];
    restoreErrors: string[];
    totalRows: number;
  } | null>(null);
  const [restoreResult, setRestoreResult] = useState<{
    restored: Record<string, number>;
    totalRows: number;
  } | null>(null);
  const [confirmFreshPractice, setConfirmFreshPractice] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [deletionContactEmail, setDeletionContactEmail] = useState("");
  const [deletionReason, setDeletionReason] = useState("");
  const [confirmExportDownloaded, setConfirmExportDownloaded] = useState(false);
  const [confirmManualReview, setConfirmManualReview] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importRequestKeyRef = useRef<string | null>(null);
  const importFileReadVersionRef = useRef(0);
  const backupFileInputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();
  const exportClients = trpc.data.exportClients.useQuery(undefined, {
    enabled: false,
  });
  const exportPatients = trpc.data.exportPatients.useQuery(undefined, {
    enabled: false,
  });
  const exportAppointments = trpc.data.exportAppointments.useQuery(undefined, {
    enabled: false,
  });
  const exportInvoices = trpc.data.exportInvoices.useQuery(undefined, {
    enabled: false,
  });
  const exportFullBackup = trpc.data.exportFullBackup.useQuery(undefined, {
    enabled: false,
  });
  const restoreBackup = trpc.data.restoreBackup.useMutation({
    onSuccess: (data) => {
      if (data.dryRun) {
        setBackupSummary({
          counts: data.counts,
          missingSections: data.missingSections,
          restoreErrors: data.restoreErrors,
          totalRows: data.totalRows,
        });
        setRestoreResult(null);
        if (data.missingSections.length > 0) {
          toast.error("Backup is missing required sections");
        } else if (data.restoreErrors.length > 0) {
          toast.error("Backup has invalid restore data");
        } else {
          toast.success("Backup verified");
        }
        return;
      }

      setRestoreResult({
        restored: data.restored,
        totalRows: data.totalRows,
      });
      setConfirmFreshPractice(false);
      toast.success(`Restored ${data.totalRows} rows`);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const accountDeletionRequest =
    trpc.settings.getAccountDeletionRequest.useQuery();
  const {
    data: practiceSettings,
    isLoading: practiceSettingsLoading,
    error: practiceSettingsError,
  } = trpc.settings.getPractice.useQuery();
  const practiceSettingsMissing =
    !practiceSettingsLoading && !practiceSettingsError && !practiceSettings;
  const verifiedPracticeSettings =
    practiceSettingsError || practiceSettingsMissing || !practiceSettings
      ? null
      : practiceSettings;
  const settingsTimeZone = verifiedPracticeSettings
    ? verifiedPracticeSettings.timezone
    : null;

  function handleCsvImportError(err: {
    data?: { code?: string | null } | null;
    message: string;
  }) {
    if (err.data?.code === "CONFLICT") {
      importRequestKeyRef.current = null;
      setImportPreview(null);
      setImportRecoveryMessage(
        "This preview expired or the clinic data changed. Nothing new was imported by this attempt. Check the same file again.",
      );
      toast.error("Check the CSV again before importing.");
      return;
    }
    toast.error(err.message);
  }

  const importClientsCsv = trpc.data.importClientsCsv.useMutation({
    onSuccess: (data, variables) => {
      if ("dryRun" in data && data.dryRun) {
        const requestKey = importPreviewRequestKey(
          "clients",
          variables.source ?? "other",
          variables.csv,
        );
        if (importRequestKeyRef.current !== requestKey) return;
        setImportPreview({
          requestKey,
          previewToken: data.previewToken,
          total: data.total,
          willInsert: data.willInsert,
          willReconcile: data.willReconcile,
          duplicates: data.duplicates,
          errors: data.errors,
        });
        setImportRecoveryMessage("");
        setImportResult(null);
        toast.success("Client CSV checked");
        return;
      }

      setImportResult({
        imported: data.imported ?? 0,
        reconciled: data.reconciled,
        errors: data.errors,
      });
      setImportPreview(null);
      setCsvText("");
      setCsvFileName("");
      setImportRecoveryMessage("");
      toast.success("Clients imported");
    },
    onError: handleCsvImportError,
  });
  const importPatientsCsv = trpc.data.importPatientsCsv.useMutation({
    onSuccess: (data, variables) => {
      if ("dryRun" in data && data.dryRun) {
        const requestKey = importPreviewRequestKey(
          "patients",
          variables.source ?? "other",
          variables.csv,
        );
        if (importRequestKeyRef.current !== requestKey) return;
        setImportPreview({
          requestKey,
          previewToken: data.previewToken,
          total: data.total,
          willInsert: data.willInsert,
          willReconcile: data.willReconcile,
          duplicates: data.duplicates,
          unmatchedClient: data.unmatchedClient,
          errors: data.errors,
        });
        setImportRecoveryMessage("");
        setImportResult(null);
        toast.success("Patient CSV checked");
        return;
      }

      setImportResult({
        imported: data.imported ?? 0,
        reconciled: data.reconciled,
        errors: data.errors,
      });
      setImportPreview(null);
      setCsvText("");
      setCsvFileName("");
      setImportRecoveryMessage("");
      toast.success("Patients imported");
    },
    onError: handleCsvImportError,
  });
  const importVaccinationsCsv = trpc.data.importVaccinationsCsv.useMutation({
    onSuccess: (data, variables) => {
      if ("dryRun" in data && data.dryRun) {
        const requestKey = importPreviewRequestKey(
          "vaccinations",
          variables.source ?? "other",
          variables.csv,
        );
        if (importRequestKeyRef.current !== requestKey) return;
        setImportPreview({
          requestKey,
          previewToken: data.previewToken,
          total: data.total,
          willInsert: data.willInsert,
          duplicates: data.duplicates,
          unmatchedPatient: data.unmatchedPatient,
          errors: data.errors,
        });
        setImportRecoveryMessage("");
        setImportResult(null);
        toast.success("Vaccination CSV checked");
        return;
      }

      setImportResult({ imported: data.imported ?? 0, errors: data.errors });
      setImportPreview(null);
      setCsvText("");
      setCsvFileName("");
      setImportRecoveryMessage("");
      toast.success("Vaccine history imported");
    },
    onError: handleCsvImportError,
  });
  const importSoapNotesCsv = trpc.data.importSoapNotesCsv.useMutation({
    onSuccess: (data, variables) => {
      if ("dryRun" in data && data.dryRun) {
        const requestKey = importPreviewRequestKey(
          "soapNotes",
          variables.source ?? "other",
          variables.csv,
        );
        if (importRequestKeyRef.current !== requestKey) return;
        setImportPreview({
          requestKey,
          previewToken: data.previewToken,
          total: data.total,
          willInsert: data.willInsert,
          duplicates: data.duplicates,
          unmatchedPatient: data.unmatchedPatient,
          errors: data.errors,
        });
        setImportRecoveryMessage("");
        setImportResult(null);
        toast.success("Medical history CSV checked");
        return;
      }

      setImportResult({ imported: data.imported ?? 0, errors: data.errors });
      setImportPreview(null);
      setCsvText("");
      setCsvFileName("");
      setImportRecoveryMessage("");
      toast.success("Medical history imported");
    },
    onError: handleCsvImportError,
  });

  const requestAccountDeletion =
    trpc.settings.requestAccountDeletion.useMutation({
      onSuccess: () => {
        utils.settings.getAccountDeletionRequest.invalidate();
        setConfirmExportDownloaded(false);
        setConfirmManualReview(false);
        toast.success("Account deletion request sent");
      },
      onError: (err) => toast.error(err.message),
    });

  const onboarding = trpc.settings.onboardingStatus.useQuery();
  const onboardingMissing =
    !onboarding.isLoading && !onboarding.error && !onboarding.data;
  const verifiedOnboardingStatus =
    onboarding.error || onboardingMissing || !onboarding.data
      ? null
      : onboarding.data;
  const hasDemo = verifiedOnboardingStatus
    ? verifiedOnboardingStatus.hasDemoData
    : false;
  const clearDemo = trpc.settings.clearDemoData.useMutation({
    onSuccess: () => {
      utils.settings.onboardingStatus.invalidate();
      toast.success("Sample data removed");
    },
    onError: (err) => toast.error(err.message),
  });
  const reseedDemo = trpc.settings.reseedDemoData.useMutation({
    onSuccess: () => {
      utils.settings.onboardingStatus.invalidate();
      toast.success("Sample data added");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleExport = useCallback(
    async (type: "clients" | "patients" | "appointments" | "invoices") => {
      setExportingType(type);
      try {
        let data: Record<string, unknown>[] = [];
        if (type === "clients") {
          const result = await exportClients.refetch();
          data = requireSettingsExportData(
            result,
            "Could not export clients",
          ) as Record<string, unknown>[];
        } else if (type === "patients") {
          const result = await exportPatients.refetch();
          data = requireSettingsExportData(
            result,
            "Could not export patients",
          ) as Record<string, unknown>[];
        } else if (type === "appointments") {
          const result = await exportAppointments.refetch();
          data = requireSettingsExportData(
            result,
            "Could not export appointments",
          ) as Record<string, unknown>[];
        } else if (type === "invoices") {
          const result = await exportInvoices.refetch();
          // Flatten items for CSV
          const raw = requireSettingsExportData(
            result,
            "Could not export invoices",
          );
          data = raw.map((inv) => {
            const { items, ...rest } = inv;
            return {
              ...rest,
              items: items
                .map((i: { description: string }) => i.description)
                .join("; "),
            } as Record<string, unknown>;
          });
        }
        downloadCSV(data, `${type}-export.csv`);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not export data",
        );
      } finally {
        setExportingType(null);
      }
    },
    [exportClients, exportPatients, exportAppointments, exportInvoices],
  );

  const handleFullBackupExport = useCallback(async () => {
    setExportingType("full-backup");
    try {
      if (!verifiedPracticeSettings) {
        throw new Error("Could not load practice settings for backup export");
      }
      const result = await exportFullBackup.refetch();
      const backup = requireSettingsExportData(
        result,
        "Could not export full backup",
      );
      const date = formatSettingsDateInput(new Date(), settingsTimeZone);
      downloadJSON(backup, `openvpm-full-backup-${date}.json`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not export full backup",
      );
    } finally {
      setExportingType(null);
    }
  }, [exportFullBackup, settingsTimeZone, verifiedPracticeSettings]);

  const handleBackupFileSelect = useCallback(
    (file: File) => {
      function clearBackupFile() {
        setBackupFileName("");
        setBackupPayload(null);
        setBackupSummary(null);
        setRestoreResult(null);
        setConfirmFreshPractice(false);
      }

      if (file.size > PRACTICE_BACKUP_JSON_MAX_BYTES) {
        clearBackupFile();
        toast.error(PRACTICE_BACKUP_JSON_SIZE_MESSAGE);
        return;
      }

      setBackupFileName(file.name);
      setBackupPayload(null);
      setBackupSummary(null);
      setRestoreResult(null);
      setConfirmFreshPractice(false);

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = String(e.target?.result ?? "");
          if (!isPracticeBackupJsonSizeValid(text)) {
            clearBackupFile();
            toast.error(PRACTICE_BACKUP_JSON_SIZE_MESSAGE);
            return;
          }
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Backup JSON must be an object");
          }
          const backup = parsed as Record<string, unknown>;
          setBackupPayload(backup);
          restoreBackup.mutate({ backup, dryRun: true });
        } catch (err) {
          setBackupFileName("");
          setBackupPayload(null);
          toast.error(
            err instanceof Error ? err.message : "Could not read backup JSON",
          );
        }
      };
      reader.onerror = () => {
        clearBackupFile();
        toast.error("Could not read backup JSON");
      };
      reader.readAsText(file);
    },
    [restoreBackup],
  );

  const handleBackupRestore = useCallback(() => {
    if (!backupPayload || !confirmFreshPractice) return;
    if (!isPracticeBackupJsonSizeValid(backupPayload)) {
      toast.error(PRACTICE_BACKUP_JSON_SIZE_MESSAGE);
      return;
    }
    restoreBackup.mutate({
      backup: backupPayload,
      dryRun: false,
      confirmFreshPractice: true,
    });
  }, [backupPayload, confirmFreshPractice, restoreBackup]);

  const handleDeletionRequest = useCallback(() => {
    if (!confirmExportDownloaded || !confirmManualReview) return;
    requestAccountDeletion.mutate({
      contactEmail: deletionContactEmail.trim(),
      reason: deletionReason.trim() || undefined,
      confirmExportDownloaded: true,
      confirmManualReview: true,
    });
  }, [
    confirmExportDownloaded,
    confirmManualReview,
    deletionContactEmail,
    deletionReason,
    requestAccountDeletion,
  ]);

  const runImportPreview = useCallback(
    (text: string) => {
      if (!importMode || !migrationSource) {
        toast.error("Choose the system you are moving from first.");
        return;
      }
      setImportPreview(null);
      setImportResult(null);
      setImportRecoveryMessage("");
      importRequestKeyRef.current = importPreviewRequestKey(
        importMode,
        migrationSource,
        text,
      );
      const input = {
        csv: text,
        dryRun: true as const,
        source: migrationSource,
        migrationProtocol: "reviewed-v1" as const,
      };
      if (importMode === "clients") importClientsCsv.mutate(input);
      else if (importMode === "patients") importPatientsCsv.mutate(input);
      else if (importMode === "vaccinations")
        importVaccinationsCsv.mutate(input);
      else importSoapNotesCsv.mutate(input);
    },
    [
      importClientsCsv,
      importMode,
      importPatientsCsv,
      importSoapNotesCsv,
      importVaccinationsCsv,
      migrationSource,
    ],
  );

  const handleFileSelect = useCallback(
    (file: File) => {
      if (!importMode || !migrationSource) {
        toast.error("Choose the system you are moving from first.");
        return;
      }
      const readVersion = ++importFileReadVersionRef.current;
      function clearImportFile() {
        importRequestKeyRef.current = null;
        setCsvFileName("");
        setCsvText("");
        setImportPreview(null);
        setImportResult(null);
        setImportRecoveryMessage("");
      }

      if (file.size > IMPORT_CSV_MAX_BYTES) {
        clearImportFile();
        toast.error(IMPORT_CSV_SIZE_MESSAGE);
        return;
      }

      setCsvFileName(file.name);
      setCsvText("");
      setImportPreview(null);
      setImportResult(null);
      setImportRecoveryMessage("");
      const reader = new FileReader();
      reader.onload = (e) => {
        if (importFileReadVersionRef.current !== readVersion) return;
        const text = String(e.target?.result ?? "");
        if (!text.trim()) {
          setCsvFileName("");
          toast.error("CSV file is empty");
          return;
        }
        if (!isImportCsvSizeValid(text)) {
          clearImportFile();
          toast.error(IMPORT_CSV_SIZE_MESSAGE);
          return;
        }

        setCsvText(text);
        runImportPreview(text);
      };
      reader.onerror = () => {
        if (importFileReadVersionRef.current !== readVersion) return;
        setCsvFileName("");
        toast.error("Could not read CSV file");
      };
      reader.readAsText(file);
    },
    [importMode, migrationSource, runImportPreview],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith(".csv")) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect],
  );

  const handleImportConfirm = useCallback(() => {
    if (!csvText || !importMode || !importPreview) return;
    if (!isImportCsvSizeValid(csvText)) {
      toast.error(IMPORT_CSV_SIZE_MESSAGE);
      return;
    }
    const currentRequestKey = importPreviewRequestKey(
      importMode,
      importSource,
      csvText,
    );
    if (importPreview.requestKey !== currentRequestKey) {
      importRequestKeyRef.current = null;
      setImportPreview(null);
      toast.error("The file or source changed. Check the CSV again.");
      return;
    }
    if (importMode === "clients") {
      importClientsCsv.mutate({
        csv: csvText,
        dryRun: false,
        source: importSource,
        previewToken: importPreview.previewToken,
        migrationProtocol: "reviewed-v1",
      });
    } else if (importMode === "patients") {
      importPatientsCsv.mutate({
        csv: csvText,
        dryRun: false,
        source: importSource,
        previewToken: importPreview.previewToken,
        migrationProtocol: "reviewed-v1",
      });
    } else if (importMode === "vaccinations") {
      importVaccinationsCsv.mutate({
        csv: csvText,
        dryRun: false,
        source: importSource,
        previewToken: importPreview.previewToken,
        migrationProtocol: "reviewed-v1",
      });
    } else {
      importSoapNotesCsv.mutate({
        csv: csvText,
        dryRun: false,
        source: importSource,
        previewToken: importPreview.previewToken,
        migrationProtocol: "reviewed-v1",
      });
    }
  }, [
    csvText,
    importMode,
    importPreview,
    importSource,
    importClientsCsv,
    importPatientsCsv,
    importVaccinationsCsv,
    importSoapNotesCsv,
  ]);

  const isImportPending =
    importClientsCsv.isPending ||
    importPatientsCsv.isPending ||
    importVaccinationsCsv.isPending ||
    importSoapNotesCsv.isPending;
  const canRestoreBackup =
    Boolean(backupPayload) &&
    Boolean(backupSummary) &&
    backupSummary?.missingSections.length === 0 &&
    backupSummary?.restoreErrors.length === 0 &&
    confirmFreshPractice &&
    !restoreBackup.isPending;
  const deletionRequest = accountDeletionRequest.data;
  const deletionSettingsMissing =
    Boolean(deletionRequest?.requestedAt) &&
    (practiceSettingsMissing || !verifiedPracticeSettings);
  const deletionRequestedAt = deletionRequest?.requestedAt
    ? formatSettingsDateTime(deletionRequest.requestedAt, settingsTimeZone)
    : null;
  const isDeletionStatusLoading =
    accountDeletionRequest.isLoading ||
    (Boolean(deletionRequest?.requestedAt) && practiceSettingsLoading);
  const deletionStatusError =
    accountDeletionRequest.error ??
    (deletionRequest?.requestedAt ? practiceSettingsError : null) ??
    (deletionSettingsMissing
      ? new Error("Could not load practice settings. Please retry.")
      : null);
  const isDeletionContactEmailValid = (email: string) =>
    email.trim().length <= SETTINGS_EMAIL_MAX_LENGTH &&
    isValidEmail(email.trim());
  const isDeletionReasonValid = (reason: string) =>
    reason.trim().length <= ACCOUNT_DELETION_REASON_MAX_LENGTH;
  const canSubmitDeletion =
    isDeletionContactEmailValid(deletionContactEmail) &&
    isDeletionReasonValid(deletionReason) &&
    confirmExportDownloaded &&
    confirmManualReview &&
    !requestAccountDeletion.isPending;

  return (
    <div className="space-y-8">
      {/* Sample data */}
      <div>
        <h3 className="text-sm font-semibold mb-1">Sample data</h3>
        <p className="text-sm text-muted-foreground mb-4">
          A practice full of made up clients and pets so you can explore. Add it
          any time, and remove it when you are ready to work for real.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            if (!verifiedOnboardingStatus) return;
            if (hasDemo) {
              clearDemo.mutate();
            } else {
              reseedDemo.mutate();
            }
          }}
          disabled={
            onboarding.isLoading ||
            Boolean(onboarding.error) ||
            onboardingMissing ||
            !verifiedOnboardingStatus ||
            clearDemo.isPending ||
            reseedDemo.isPending
          }
        >
          {hasDemo ? "Remove sample data" : "Add sample data"}
        </Button>
        {onboarding.error || onboardingMissing ? (
          <p className="mt-2 text-xs text-destructive">
            {onboarding.error?.message ??
              "Unable to load sample data status. Please retry."}
          </p>
        ) : null}
      </div>

      {/* Export Section */}
      <div>
        <h3 className="text-sm font-semibold mb-1">Export Data</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Download your practice data.
        </p>
        <div className="mb-3 max-w-2xl">
          <Button
            variant="outline"
            className="w-full justify-start gap-2"
            disabled={
              exportingType !== null ||
              practiceSettingsLoading ||
              Boolean(practiceSettingsError) ||
              practiceSettingsMissing ||
              !verifiedPracticeSettings
            }
            onClick={handleFullBackupExport}
          >
            {exportingType === "full-backup" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <Database className="h-4 w-4" />
            Export Full Backup
          </Button>
          {practiceSettingsError || practiceSettingsMissing ? (
            <p className="mt-2 text-xs text-destructive">
              {practiceSettingsError?.message ??
                "Unable to load practice settings for backup export."}
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3 max-w-2xl">
          {(
            [
              { key: "clients", label: "Export Clients", icon: Users },
              {
                key: "patients",
                label: "Export Patients",
                icon: FileSpreadsheet,
              },
              {
                key: "appointments",
                label: "Export Appointments",
                icon: Calendar,
              },
              {
                key: "invoices",
                label: "Export Invoices",
                icon: FileSpreadsheet,
              },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              variant="outline"
              className="justify-start gap-2"
              disabled={exportingType !== null}
              onClick={() => handleExport(key)}
            >
              {exportingType === key ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              <Icon className="h-4 w-4" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* Full backup restore */}
      <div>
        <h3 className="text-sm font-semibold mb-1">Restore Full Backup</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Restore a full backup into a fresh practice. Existing clients,
          patients, appointments, or invoices block the restore.
        </p>
        <div className="max-w-2xl rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-4">
              <div>
                <p className="text-sm font-medium">Fresh-practice restore</p>
                <p className="mt-1 text-xs leading-5 text-amber-900 dark:text-amber-200">
                  OpenVPM first checks the backup sections, row counts, and
                  internal record links. Restores are non-destructive and only
                  insert rows that do not already exist.{" "}
                  {PRACTICE_BACKUP_JSON_SIZE_MESSAGE}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2 bg-background"
                  disabled={restoreBackup.isPending}
                  onClick={() => backupFileInputRef.current?.click()}
                >
                  {restoreBackup.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Choose Backup JSON
                </Button>
                {backupFileName && (
                  <span className="truncate text-xs text-amber-900 dark:text-amber-200">
                    {backupFileName}
                  </span>
                )}
                <input
                  ref={backupFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleBackupFileSelect(file);
                    e.currentTarget.value = "";
                  }}
                />
              </div>

              {backupSummary && (
                <div className="rounded-md border border-amber-200 bg-background/80 p-3 text-sm text-foreground dark:border-amber-900/60 dark:bg-background/60">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        backupSummary.missingSections.length > 0 ||
                        backupSummary.restoreErrors.length > 0
                          ? "destructive"
                          : "success"
                      }
                    >
                      {backupSummary.missingSections.length > 0
                        ? "Missing sections"
                        : backupSummary.restoreErrors.length > 0
                          ? "Invalid backup data"
                          : "Verified"}
                    </Badge>
                    <span className="text-muted-foreground">
                      {backupSummary.totalRows.toLocaleString()} rows detected
                    </span>
                  </div>

                  {backupSummary.missingSections.length > 0 ? (
                    <p className="mt-2 text-xs text-destructive">
                      Missing: {backupSummary.missingSections.join(", ")}
                    </p>
                  ) : backupSummary.restoreErrors.length > 0 ? (
                    <div className="mt-2 space-y-1 text-xs text-destructive">
                      {backupSummary.restoreErrors.slice(0, 3).map((error) => (
                        <p key={error}>{error}</p>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {Object.entries(backupSummary.counts)
                        .filter(([, count]) => count > 0)
                        .slice(0, 8)
                        .map(([section, count]) => (
                          <div
                            key={section}
                            className="rounded-md bg-muted/60 px-2 py-1"
                          >
                            <p className="truncate text-[11px] text-muted-foreground">
                              {section}
                            </p>
                            <p className="text-sm font-semibold">
                              {count.toLocaleString()}
                            </p>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {restoreResult && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
                  <div className="flex items-center gap-2 font-medium">
                    <Check className="h-4 w-4" />
                    Restored {restoreResult.totalRows.toLocaleString()} rows
                  </div>
                </div>
              )}

              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={confirmFreshPractice}
                  disabled={
                    !backupSummary ||
                    backupSummary.missingSections.length > 0 ||
                    backupSummary.restoreErrors.length > 0 ||
                    restoreBackup.isPending
                  }
                  onChange={(e) =>
                    setConfirmFreshPractice(e.currentTarget.checked)
                  }
                  className="mt-0.5"
                />
                <span>
                  I confirm this practice has no live clients, patients,
                  appointments, or invoices.
                </span>
              </label>

              <Button
                type="button"
                className="gap-2"
                disabled={!canRestoreBackup}
                onClick={handleBackupRestore}
              >
                {restoreBackup.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Database className="h-4 w-4" />
                )}
                Restore into Fresh Practice
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Account deletion */}
      <div>
        <h3 className="text-sm font-semibold mb-1">Account Deletion</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Start a deletion review after exporting the full backup.
        </p>
        <div className="max-w-2xl rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          {isDeletionStatusLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading deletion status
            </div>
          ) : deletionStatusError ? (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Could not load deletion status</p>
                <p className="mt-1 text-xs">{deletionStatusError.message}</p>
              </div>
            </div>
          ) : deletionRequest ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="warning">Review requested</Badge>
                {deletionRequestedAt && (
                  <span className="text-sm text-muted-foreground">
                    {deletionRequestedAt}
                  </span>
                )}
              </div>
              <div className="grid gap-1 text-sm">
                <div>
                  <span className="font-medium">Contact:</span>{" "}
                  {deletionRequest.contactEmail}
                </div>
                <div>
                  <span className="font-medium">Requested by:</span>{" "}
                  {deletionRequest.requestedByEmail}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="account-deletion-contact"
                  className="mb-1 block text-sm font-medium"
                >
                  Contact email
                </label>
                <Input
                  id="account-deletion-contact"
                  type="email"
                  value={deletionContactEmail}
                  maxLength={SETTINGS_EMAIL_MAX_LENGTH}
                  onChange={(e) => setDeletionContactEmail(e.target.value)}
                  placeholder="owner@example.com"
                />
              </div>
              <div>
                <label
                  htmlFor="account-deletion-reason"
                  className="mb-1 block text-sm font-medium"
                >
                  Notes
                </label>
                <textarea
                  id="account-deletion-reason"
                  value={deletionReason}
                  onChange={(e) => setDeletionReason(e.target.value)}
                  maxLength={ACCOUNT_DELETION_REASON_MAX_LENGTH}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="Optional context for the ops review"
                />
              </div>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={confirmExportDownloaded}
                  onChange={(e) =>
                    setConfirmExportDownloaded(e.currentTarget.checked)
                  }
                  className="mt-0.5"
                />
                <span>
                  I downloaded the full backup before requesting deletion.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={confirmManualReview}
                  onChange={(e) =>
                    setConfirmManualReview(e.currentTarget.checked)
                  }
                  className="mt-0.5"
                />
                <span>
                  I understand deletion needs manual retention review before
                  records are erased.
                </span>
              </label>
              <Button
                variant="destructive"
                className="gap-2"
                disabled={!canSubmitDeletion}
                onClick={handleDeletionRequest}
              >
                {requestAccountDeletion.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Request Deletion Review
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Import Section */}
      <div>
        <h3 className="text-sm font-semibold mb-1">Import Data</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Moving from another system? Import clients first, then patients, then
          vaccine history, then medical history (visit notes). Every file is
          dry-run first so you see duplicates and missing matches before
          anything is saved. Common column names from AVImark, Cornerstone, and
          ezyVet are recognized. Shepherd migrations are currently guided so we
          can verify the clinic's exact export format. Owner and patient IDs
          stay linked across files, even when an owner has no email.
        </p>

        {/* Where the data is coming from (export instructions per source) */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Coming from:
          </span>
          {MIGRATION_SOURCES.map((source) => (
            <button
              key={source.id}
              type="button"
              onClick={() => {
                importFileReadVersionRef.current += 1;
                importRequestKeyRef.current = null;
                setMigrationSource(source.id);
                setImportMode(null);
                setCsvText("");
                setCsvFileName("");
                setImportPreview(null);
                setImportResult(null);
                setImportRecoveryMessage("");
              }}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                migrationSource === source.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/50",
              )}
            >
              {source.name}
            </button>
          ))}
        </div>
        {migrationSource ? (
          <div className="mb-4 max-w-2xl rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <p>
              {
                MIGRATION_SOURCES.find((s) => s.id === migrationSource)!
                  .exportHint
              }
            </p>
            {migrationSource === "shepherd" ? (
              <a
                href="mailto:support@openvpm.com?subject=Assisted%20Shepherd%20migration"
                className="mt-2 inline-flex font-medium text-primary hover:underline"
              >
                Request a migration review before the full import
              </a>
            ) : null}
          </div>
        ) : (
          <p className="mb-4 text-xs font-medium text-amber-700">
            Choose the system you are moving from before selecting an import.
          </p>
        )}

        {/* Import mode selector */}
        <div className="flex flex-wrap gap-2 mb-4">
          {MIGRATION_STEPS.map(({ mode, label }, index) => (
            <Button
              key={mode}
              variant={importMode === mode ? "default" : "outline"}
              size="sm"
              disabled={!migrationSource}
              onClick={() => {
                importFileReadVersionRef.current += 1;
                setImportMode(mode);
                setCsvText("");
                setCsvFileName("");
                setImportPreview(null);
                setImportResult(null);
                setImportRecoveryMessage("");
              }}
            >
              <Upload className="mr-2 h-4 w-4" />
              {index + 1}. Import {label}
            </Button>
          ))}
        </div>

        {importMode && (
          <div className="max-w-2xl space-y-4">
            {/* Expected columns hint */}
            <p className="text-xs text-muted-foreground">
              Expected columns:{" "}
              {
                MIGRATION_STEPS.find((step) => step.mode === importMode)!
                  .columnHint
              }
            </p>

            {/* Drop zone */}
            <div
              className={cn(
                "rounded-lg border-2 border-dashed p-8 text-center transition-colors cursor-pointer",
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                Drag and drop a CSV file here, or click to select
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                CSV files must be 5 MB or less. The file is dry-run first; no
                rows import until you confirm.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Existing owners connect by one exact email. Existing pets need a
                matching microchip or date of birth before an ID is connected.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                  e.currentTarget.value = "";
                }}
              />
            </div>

            {/* Server dry-run preview */}
            {csvFileName && (
              <p className="text-xs text-muted-foreground">
                Selected file:{" "}
                <span className="font-medium">{csvFileName}</span>
              </p>
            )}

            {importRecoveryMessage && csvText ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <p>{importRecoveryMessage}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={isImportPending}
                  onClick={() => runImportPreview(csvText)}
                >
                  {isImportPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Check again
                </Button>
              </div>
            ) : null}

            {importPreview && (
              <div className="space-y-3">
                <div className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        importPreview.willInsert > 0 ? "success" : "warning"
                      }
                    >
                      Dry run complete
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      No data has been imported yet.
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <ImportStat
                      label="Rows parsed"
                      value={importPreview.total}
                    />
                    <ImportStat
                      label="Will import"
                      value={importPreview.willInsert}
                    />
                    {typeof importPreview.duplicates === "number" && (
                      <ImportStat
                        label="Duplicates"
                        value={importPreview.duplicates ?? 0}
                      />
                    )}
                    {typeof importPreview.willReconcile === "number" &&
                      importPreview.willReconcile > 0 && (
                        <ImportStat
                          label="IDs to connect"
                          value={importPreview.willReconcile}
                        />
                      )}
                    {importMode === "patients" && (
                      <ImportStat
                        label="Missing owners"
                        value={importPreview.unmatchedClient ?? 0}
                      />
                    )}
                    {(importMode === "vaccinations" ||
                      importMode === "soapNotes") && (
                      <ImportStat
                        label="Missing pets"
                        value={importPreview.unmatchedPatient ?? 0}
                      />
                    )}
                    <ImportStat
                      label="Row issues"
                      value={importPreview.errors.length}
                    />
                  </div>

                  {importPreview.errors.length > 0 && (
                    <div className="mt-4 space-y-1">
                      <p className="text-sm font-medium text-destructive">
                        {importPreview.errors.length} row issue(s):
                      </p>
                      <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-destructive">
                        {importPreview.errors.map((err, i) => (
                          <li key={i}>{err}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="mt-4 text-xs text-muted-foreground">
                    Only the{" "}
                    {importPreview.willInsert +
                      (importPreview.willReconcile ?? 0)}{" "}
                    listed changes will be saved. {importPreview.errors.length}{" "}
                    issue row(s) will be skipped.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={
                      isImportPending ||
                      importPreview.willInsert +
                        (importPreview.willReconcile ?? 0) ===
                        0
                    }
                    onClick={handleImportConfirm}
                  >
                    {isImportPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-2 h-4 w-4" />
                    )}
                    Confirm Import (
                    {importPreview.willInsert +
                      (importPreview.willReconcile ?? 0)}{" "}
                    changes)
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      importFileReadVersionRef.current += 1;
                      importRequestKeyRef.current = null;
                      setCsvText("");
                      setCsvFileName("");
                      setImportPreview(null);
                      setImportRecoveryMessage("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Import result */}
            {importResult && (
              <div className="rounded-lg border border-border bg-card p-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-400">
                  <Check className="h-4 w-4" />
                  {importResult.imported} records imported successfully
                  {(importResult.reconciled ?? 0) > 0
                    ? `; ${importResult.reconciled} existing record IDs connected`
                    : ""}
                </div>
                {importResult.errors && importResult.errors.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-destructive">
                      {importResult.errors.length} error(s):
                    </p>
                    <ul className="text-xs text-destructive space-y-0.5">
                      {importResult.errors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Mutation error */}
            {(importClientsCsv.error ||
              importPatientsCsv.error ||
              importVaccinationsCsv.error ||
              importSoapNotesCsv.error) && (
              <p className="text-sm text-destructive">
                {importClientsCsv.error?.message ??
                  importPatientsCsv.error?.message ??
                  importVaccinationsCsv.error?.message ??
                  importSoapNotesCsv.error?.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ImportStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value.toLocaleString()}</p>
    </div>
  );
}

// ── Rooms ───────────────────────────────────────────────────
function RoomsTab() {
  const utils = trpc.useUtils();
  const {
    data: roomList,
    isLoading,
    error: roomsError,
    refetch: refetchRooms,
  } = trpc.settings.listRooms.useQuery();
  const createMutation = trpc.settings.createRoom.useMutation({
    onSuccess: () => {
      utils.settings.listRooms.invalidate();
      setShowAdd(false);
      setAddForm({ name: "", type: "exam" });
      toast.success("Room created");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const deleteMutation = trpc.settings.deleteRoom.useMutation({
    onSuccess: () => {
      utils.settings.listRooms.invalidate();
      toast.success("Room deleted");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    type: "exam" as "exam" | "surgery" | "treatment" | "boarding",
  });
  const isRoomNameValid = (name: string) =>
    name.trim().length > 0 && name.trim().length <= ROOM_NAME_MAX_LENGTH;
  const roomsMissing = !isLoading && !roomsError && !roomList;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (roomsError) {
    return <SettingsLoadError message={roomsError.message} />;
  }
  if (roomsMissing) {
    return (
      <SettingsLoadError
        title="Could not load rooms"
        message="The room list request finished without returning data. Try loading it again before editing rooms."
        onRetry={() => void refetchRooms()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowAdd(!showAdd)} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Room
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">New Room</h3>
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Room name"
              maxLength={ROOM_NAME_MAX_LENGTH}
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            />
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={addForm.type}
              onChange={(e) =>
                setAddForm({
                  ...addForm,
                  type: e.target.value as typeof addForm.type,
                })
              }
            >
              {ROOM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                !isRoomNameValid(addForm.name) || createMutation.isPending
              }
              onClick={() => createMutation.mutate(addForm)}
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Type</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {roomList?.map((room) => (
              <tr
                key={room.id}
                className="border-b border-border last:border-0"
              >
                <td className="px-4 py-3 font-medium">{room.name}</td>
                <td className="px-4 py-3 text-muted-foreground capitalize">
                  {room.type}
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => deleteMutation.mutate({ id: room.id })}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </td>
              </tr>
            ))}
            {roomList?.length === 0 && (
              <tr>
                <td colSpan={3} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent p-8"
                    icon={DoorOpen}
                    title="No rooms configured"
                    description="Add rooms so appointments can reserve exam, treatment, surgery, or boarding spaces."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Wellness Plans ──────────────────────────────────────────
function WellnessPlansTab() {
  const formatCurrency = useCurrencyFormatter();
  const utils = trpc.useUtils();
  const {
    data: plans,
    isLoading,
    error: wellnessError,
    refetch: refetchWellnessPlans,
  } = trpc.wellness.listPlans.useQuery();
  const createMutation = trpc.wellness.createPlan.useMutation({
    onSuccess: () => {
      utils.wellness.listPlans.invalidate();
      setShowAdd(false);
      setAddForm({
        name: "",
        description: "",
        price: "",
        billingInterval: "monthly",
      });
      toast.success("Wellness plan created");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const setPlanActive = trpc.wellness.setPlanActive.useMutation({
    onSuccess: (_plan, variables) => {
      utils.wellness.listPlans.invalidate();
      utils.wellness.listDue.invalidate();
      toast.success(
        variables.active
          ? "Wellness plan reactivated"
          : "Wellness plan deactivated",
      );
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<{
    name: string;
    description: string;
    price: string;
    billingInterval: "monthly" | "annual";
  }>({
    name: "",
    description: "",
    price: "",
    billingInterval: "monthly",
  });
  const priceValue = Number(addForm.price);
  const canCreate =
    addForm.name.trim().length > 0 &&
    addForm.name.trim().length <= WELLNESS_PLAN_NAME_MAX_LENGTH &&
    addForm.description.trim().length <= WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH &&
    isWellnessPlanPriceInputValid(addForm.price) &&
    !createMutation.isPending;
  const wellnessPlansMissing = !isLoading && !wellnessError && !plans;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (wellnessError) {
    return <SettingsLoadError message={wellnessError.message} />;
  }
  if (wellnessPlansMissing) {
    return (
      <SettingsLoadError
        title="Could not load wellness plans"
        message="The wellness plan request finished without returning data. Try loading it again before editing membership plans."
        onRetry={() => void refetchWellnessPlans()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Scheduled invoice billing</h3>
            <Badge variant="secondary">No auto-charge</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Wellness plans generate due invoices by cadence; Stripe checkout is
            collected on each invoice.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Plan
        </Button>
      </div>

      {showAdd && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">New Wellness Plan</h3>
          <div className="grid gap-3 md:grid-cols-[1fr_9rem_9rem]">
            <Input
              placeholder="Plan name"
              maxLength={WELLNESS_PLAN_NAME_MAX_LENGTH}
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            />
            <Input
              type="number"
              min={WELLNESS_PLAN_PRICE_MIN}
              max={WELLNESS_PLAN_PRICE_MAX}
              step={10 ** -WELLNESS_PLAN_PRICE_SCALE}
              placeholder="Price"
              value={addForm.price}
              onChange={(e) =>
                setAddForm({ ...addForm, price: e.target.value })
              }
            />
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={addForm.billingInterval}
              onChange={(e) =>
                setAddForm({
                  ...addForm,
                  billingInterval: e.target
                    .value as typeof addForm.billingInterval,
                })
              }
            >
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
          </div>
          <Input
            placeholder="Description (optional)"
            maxLength={WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH}
            value={addForm.description}
            onChange={(e) =>
              setAddForm({ ...addForm, description: e.target.value })
            }
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!canCreate}
              onClick={() =>
                createMutation.mutate({
                  name: addForm.name.trim(),
                  description: addForm.description.trim() || undefined,
                  price: priceValue,
                  billingInterval: addForm.billingInterval,
                })
              }
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Interval</th>
              <th className="px-4 py-3 text-right font-medium">Price</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {plans?.map((plan) => (
              <tr
                key={plan.id}
                className="border-b border-border last:border-0"
              >
                <td className="px-4 py-3">
                  <div className="font-medium">{plan.name}</div>
                  {plan.description && (
                    <div className="text-sm text-muted-foreground">
                      {plan.description}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="capitalize text-muted-foreground">
                    {plan.billingInterval}
                  </div>
                  <Badge variant="outline" className="mt-1">
                    Invoice schedule
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatCurrency(plan.price)}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={plan.active ? "default" : "secondary"}>
                    {plan.active ? "Active" : "Inactive"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={setPlanActive.isPending}
                    onClick={() =>
                      setPlanActive.mutate({
                        planId: plan.id,
                        active: !plan.active,
                      })
                    }
                  >
                    {plan.active ? "Deactivate" : "Reactivate"}
                  </Button>
                </td>
              </tr>
            ))}
            {plans?.length === 0 && (
              <tr>
                <td colSpan={5} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent p-8"
                    icon={HeartPulse}
                    title="No wellness plans configured"
                    description="Create a plan to package preventive care into scheduled invoice memberships."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Templates ────────────────────────────────────────────────
const TEMPLATE_CATEGORIES = [
  "surgery",
  "wellness",
  "dental",
  "preventive",
  "emergency",
  "other",
] as const;

type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

const CATEGORY_BADGE: Record<string, string> = {
  surgery: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  wellness:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  dental: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  preventive:
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400",
  emergency:
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  other: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
};

interface TemplateItem {
  itemType: "service" | "product";
  description: string;
  defaultQuantity: number;
  defaultUnitPrice: string;
  sortOrder: number;
}

function TemplatesTab() {
  const formatCurrency = useCurrencyFormatter();
  const utils = trpc.useUtils();
  const {
    data: templateList,
    isLoading,
    error: templatesError,
    refetch: refetchTemplates,
  } = trpc.templates.list.useQuery();
  const createMutation = trpc.templates.create.useMutation({
    onSuccess: () => {
      utils.templates.list.invalidate();
      setShowAdd(false);
      resetAddForm();
      toast.success("Template created");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const updateMutation = trpc.templates.update.useMutation({
    onSuccess: () => {
      utils.templates.list.invalidate();
      toast.success("Template updated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    description: "",
    category: "other" as TemplateCategory,
  });
  const [addItems, setAddItems] = useState<TemplateItem[]>([
    {
      itemType: "service",
      description: "",
      defaultQuantity: 1,
      defaultUnitPrice: "0",
      sortOrder: 0,
    },
  ]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );

  const resetAddForm = () => {
    setAddForm({ name: "", description: "", category: "other" });
    setAddItems([
      {
        itemType: "service",
        description: "",
        defaultQuantity: 1,
        defaultUnitPrice: "0",
        sortOrder: 0,
      },
    ]);
  };

  const addItemRow = () => {
    setAddItems([
      ...addItems,
      {
        itemType: "service",
        description: "",
        defaultQuantity: 1,
        defaultUnitPrice: "0",
        sortOrder: addItems.length,
      },
    ]);
  };

  const removeItemRow = (index: number) => {
    setAddItems(addItems.filter((_, i) => i !== index));
  };

  const updateItem = (
    index: number,
    field: keyof TemplateItem,
    value: string | number,
  ) => {
    setAddItems(
      addItems.map((item, i) =>
        i === index ? { ...item, [field]: value } : item,
      ),
    );
  };
  const templateItemsToCreate = addItems
    .map((item, index) => ({
      ...item,
      description: item.description.trim(),
      defaultUnitPrice: item.defaultUnitPrice.trim(),
      sortOrder: index,
    }))
    .filter((item) => item.description.length > 0);
  const isTemplateItemFormValid = (item: TemplateItem) =>
    item.description.trim().length > 0 &&
    item.description.trim().length <=
      TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH &&
    isTreatmentTemplateQuantityValid(item.defaultQuantity) &&
    isTreatmentTemplateUnitPriceInputValid(item.defaultUnitPrice) &&
    isTreatmentTemplateItemTotalValid(
      item.defaultUnitPrice,
      item.defaultQuantity,
    );
  const canCreateTemplate =
    addForm.name.trim().length > 0 &&
    addForm.name.trim().length <= TREATMENT_TEMPLATE_NAME_MAX_LENGTH &&
    addForm.description.trim().length <=
      TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH &&
    templateItemsToCreate.length > 0 &&
    templateItemsToCreate.length <= TREATMENT_TEMPLATE_MAX_ITEMS &&
    templateItemsToCreate.every(isTemplateItemFormValid) &&
    !createMutation.isPending;

  const selectedTemplate = templateList?.find(
    (t) => t.id === selectedTemplateId,
  );
  const {
    data: selectedTemplateDetail,
    isLoading: selectedTemplateLoading,
    error: selectedTemplateError,
    refetch: refetchSelectedTemplate,
  } = trpc.templates.getById.useQuery(
    { id: selectedTemplateId! },
    { enabled: !!selectedTemplateId },
  );
  const templatesMissing = !isLoading && !templatesError && !templateList;
  const selectedTemplateMissing =
    !!selectedTemplate &&
    !selectedTemplateLoading &&
    !selectedTemplateError &&
    !selectedTemplateDetail;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (templatesError) {
    return <SettingsLoadError message={templatesError.message} />;
  }
  if (templatesMissing) {
    return (
      <SettingsLoadError
        title="Could not load templates"
        message="The template list request finished without returning data. Try loading it again before editing treatment templates."
        onRetry={() => void refetchTemplates()}
      />
    );
  }

  // Detail view for a selected template
  if (selectedTemplate) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelectedTemplateId(null)}
          >
            <X className="mr-2 h-4 w-4" />
            Back
          </Button>
          <h3 className="text-sm font-semibold">{selectedTemplate.name}</h3>
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
              selectedTemplate.isActive !== false
                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                : "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
            )}
          >
            {selectedTemplate.isActive !== false ? "Active" : "Inactive"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={updateMutation.isPending}
            onClick={() =>
              updateMutation.mutate({
                id: selectedTemplate.id,
                isActive: !selectedTemplate.isActive,
              })
            }
          >
            {updateMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {selectedTemplate.isActive !== false ? "Deactivate" : "Activate"}
          </Button>
        </div>

        {selectedTemplate.description && (
          <p className="text-sm text-muted-foreground">
            {selectedTemplate.description}
          </p>
        )}

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Description</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Quantity</th>
                <th className="px-4 py-3 text-right font-medium">Unit Price</th>
              </tr>
            </thead>
            <tbody>
              {selectedTemplateError ? (
                <tr>
                  <td colSpan={4} className="p-4">
                    <SettingsLoadError
                      message={selectedTemplateError.message}
                    />
                  </td>
                </tr>
              ) : selectedTemplateLoading ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    Loading template items...
                  </td>
                </tr>
              ) : selectedTemplateMissing ? (
                <tr>
                  <td colSpan={4} className="p-4">
                    <SettingsLoadError
                      title="Could not load template items"
                      message="The template detail request finished without returning data. Try loading it again before using this treatment template."
                      onRetry={() => void refetchSelectedTemplate()}
                    />
                  </td>
                </tr>
              ) : selectedTemplateDetail?.items?.length ? (
                selectedTemplateDetail.items.map((item: any, i: number) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-medium">
                      {item.description}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground capitalize">
                      {item.itemType}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.defaultQuantity}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {formatCurrency(item.defaultUnitPrice)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="p-0">
                    <EmptyState
                      className="border-0 bg-transparent p-8"
                      icon={Layers}
                      title="No items in this template"
                      description="Add default services or products when creating a new treatment template."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setShowAdd(!showAdd);
            resetAddForm();
          }}
          size="sm"
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Template
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">New Treatment Template</h3>
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Template name"
              maxLength={TREATMENT_TEMPLATE_NAME_MAX_LENGTH}
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            />
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={addForm.category}
              onChange={(e) =>
                setAddForm({
                  ...addForm,
                  category: e.target.value as TemplateCategory,
                })
              }
            >
              {TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <Input
            placeholder="Description (optional)"
            maxLength={TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH}
            value={addForm.description}
            onChange={(e) =>
              setAddForm({ ...addForm, description: e.target.value })
            }
          />

          {/* Items */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Items</h4>
            {addItems.map((item, index) => (
              <div
                key={index}
                className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2"
              >
                <Input
                  placeholder="Item description"
                  maxLength={TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH}
                  value={item.description}
                  onChange={(e) =>
                    updateItem(index, "description", e.target.value)
                  }
                />
                <select
                  className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                  value={item.itemType}
                  onChange={(e) =>
                    updateItem(index, "itemType", e.target.value)
                  }
                >
                  <option value="service">Service</option>
                  <option value="product">Product</option>
                </select>
                <Input
                  type="number"
                  placeholder="Qty"
                  min={TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN}
                  max={TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX}
                  step={1}
                  className="w-20"
                  value={item.defaultQuantity}
                  onChange={(e) =>
                    updateItem(
                      index,
                      "defaultQuantity",
                      parseInt(e.target.value) || 1,
                    )
                  }
                />
                <Input
                  type="number"
                  placeholder="Price"
                  min={0}
                  max={TREATMENT_TEMPLATE_UNIT_PRICE_MAX}
                  step="0.01"
                  className="w-28"
                  value={item.defaultUnitPrice}
                  onChange={(e) =>
                    updateItem(index, "defaultUnitPrice", e.target.value)
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={addItems.length <= 1}
                  onClick={() => removeItemRow(index)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={addItems.length >= TREATMENT_TEMPLATE_MAX_ITEMS}
              onClick={addItemRow}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Item
            </Button>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!canCreateTemplate}
              onClick={() =>
                createMutation.mutate({
                  name: addForm.name.trim(),
                  description: addForm.description.trim() || undefined,
                  category: addForm.category,
                  items: templateItemsToCreate,
                })
              }
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
          </div>
          {createMutation.error && (
            <p className="text-sm text-destructive">
              {createMutation.error.message}
            </p>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Category</th>
              <th className="px-4 py-3 text-left font-medium">Items</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {templateList?.map((template) => (
              <tr
                key={template.id}
                className="border-b border-border last:border-0 cursor-pointer hover:bg-muted/30"
                onClick={() => setSelectedTemplateId(template.id)}
              >
                <td className="px-4 py-3 font-medium">{template.name}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
                      CATEGORY_BADGE[template.category ?? "other"] ??
                        CATEGORY_BADGE.other,
                    )}
                  >
                    {template.category}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">—</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                      template.isActive !== false
                        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
                    )}
                  >
                    {template.isActive !== false ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateMutation.mutate({
                        id: template.id,
                        isActive: !template.isActive,
                      });
                    }}
                  >
                    {template.isActive !== false ? (
                      <X className="h-4 w-4 text-destructive" />
                    ) : (
                      <Check className="h-4 w-4 text-green-600" />
                    )}
                  </Button>
                </td>
              </tr>
            ))}
            {templateList?.length === 0 && (
              <tr>
                <td colSpan={5} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent p-8"
                    icon={Layers}
                    title="No templates configured"
                    description="Create reusable treatment templates for common service and product bundles."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
