"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  DEFAULT_BOOKING_PAGE_CONFIG,
  isValidBookingSlug,
  BOOKING_SLUG_MAX_LENGTH,
  BOOKING_WELCOME_MAX_LENGTH,
  type BookingPageConfig,
  type BookingWeeklyHours,
} from "@/lib/booking/page-config";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const LEAD_TIME_OPTIONS = [
  { value: 0, label: "No notice needed" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 1440, label: "1 day" },
  { value: 2880, label: "2 days" },
];

const WINDOW_OPTIONS = [
  { value: 14, label: "2 weeks" },
  { value: 30, label: "1 month" },
  { value: 60, label: "2 months" },
  { value: 90, label: "3 months" },
  { value: 180, label: "6 months" },
];

const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500";

export function BookingTab() {
  const utils = trpc.useUtils();
  const myPage = trpc.booking.getMyPage.useQuery();
  const types = trpc.settings.listAppointmentTypes.useQuery();
  const save = trpc.booking.savePage.useMutation({
    onSuccess: (saved) => {
      toast.success(
        saved.published ? "Booking page published" : "Booking page saved"
      );
      utils.booking.getMyPage.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const [slug, setSlug] = useState("");
  const [published, setPublished] = useState(false);
  const [config, setConfig] = useState<BookingPageConfig>(
    DEFAULT_BOOKING_PAGE_CONFIG
  );
  const [loadedFromServer, setLoadedFromServer] = useState(false);
  const [copied, setCopied] = useState<"link" | "embed" | null>(null);

  useEffect(() => {
    if (!myPage.data || loadedFromServer) return;
    setLoadedFromServer(true);
    if (myPage.data.page) {
      setSlug(myPage.data.page.slug);
      setPublished(myPage.data.page.published);
      setConfig(myPage.data.page.config);
    } else {
      setSlug(myPage.data.suggestedSlug);
    }
  }, [myPage.data, loadedFromServer]);

  const slugValid = isValidBookingSlug(slug);
  const slugCheck = trpc.booking.checkSlug.useQuery(
    { slug },
    { enabled: slugValid }
  );
  const slugTaken = slugValid && slugCheck.data ? !slugCheck.data.available : false;

  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const pageUrl = `${origin}/book/${slug}`;
  const embedSnippet = `<a href="${pageUrl}">Book an appointment</a>`;
  const isLive = Boolean(myPage.data?.page?.published);
  const liveUrl = myPage.data?.page
    ? `${origin}/book/${myPage.data.page.slug}`
    : pageUrl;

  const allTypes = types.data ?? [];
  const bookableSet = useMemo(
    () => (config.bookableTypeIds === null ? null : new Set(config.bookableTypeIds)),
    [config.bookableTypeIds]
  );

  function setHours(day: number, hours: BookingWeeklyHours[number]) {
    setConfig((c) => {
      const next = [...c.hours] as BookingWeeklyHours;
      next[day] = hours;
      return { ...c, hours: next };
    });
  }

  function toggleType(id: string) {
    setConfig((c) => {
      if (c.bookableTypeIds === null) {
        // "All types" → uncheck one: keep every other type.
        return {
          ...c,
          bookableTypeIds: allTypes.map((t) => t.id).filter((t) => t !== id),
        };
      }
      const set = new Set(c.bookableTypeIds);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      // Back to "all" when everything is selected again.
      const nextIds = allTypes.filter((t) => set.has(t.id)).map((t) => t.id);
      return {
        ...c,
        bookableTypeIds: nextIds.length === allTypes.length ? null : nextIds,
      };
    });
  }

  async function copyText(text: string, which: "link" | "embed") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      toast.success("Copied");
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error("Could not copy");
    }
  }

  function handleSave(nextPublished: boolean) {
    if (!slugValid || slugTaken) return;
    setPublished(nextPublished);
    save.mutate({ slug, published: nextPublished, config });
  }

  if (myPage.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Globe className="h-5 w-5 text-teal-600" />
          Online booking page
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          A public page where clients (new and existing) book appointments
          straight into your calendar. Share the link, print the QR code, or
          add the button to your website.
        </p>
      </div>

      {/* Link + publish state */}
      <div className="rounded-xl border border-gray-200 p-4 space-y-3">
        <label className="block text-sm font-medium text-gray-700">
          Your booking link
        </label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 shrink-0">{origin}/book/</span>
          <Input
            value={slug}
            onChange={(e) =>
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
            }
            maxLength={BOOKING_SLUG_MAX_LENGTH}
            placeholder="your-clinic-name"
            className="max-w-xs"
          />
          {slug && slugValid && !slugCheck.isLoading && (
            slugTaken ? (
              <span className="flex items-center gap-1 text-xs text-red-600">
                <X className="h-3.5 w-3.5" /> Taken
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <Check className="h-3.5 w-3.5" /> Available
              </span>
            )
          )}
        </div>
        {slug && !slugValid && (
          <p className="text-xs text-red-600">
            Use 3 to 64 lowercase letters, numbers, and dashes.
          </p>
        )}

        {isLive && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyText(liveUrl, "link")}
            >
              {copied === "link" ? (
                <Check className="h-3.5 w-3.5 mr-1.5" />
              ) : (
                <Copy className="h-3.5 w-3.5 mr-1.5" />
              )}
              Copy link
            </Button>
            <Button type="button" variant="outline" size="sm" asChild>
              <a href={liveUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Open page
              </a>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyText(embedSnippet, "embed")}
            >
              {copied === "embed" ? (
                <Check className="h-3.5 w-3.5 mr-1.5" />
              ) : (
                <Copy className="h-3.5 w-3.5 mr-1.5" />
              )}
              Copy website button
            </Button>
          </div>
        )}
      </div>

      {/* Hours */}
      <div className="rounded-xl border border-gray-200 p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Booking hours</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            When clients can book online. Uses your practice timezone.
          </p>
        </div>
        <div className="space-y-2">
          {WEEKDAY_LABELS.map((label, day) => {
            const hours = config.hours[day];
            return (
              <div key={label} className="flex items-center gap-3">
                <label className="flex w-24 items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={hours !== null}
                    onChange={(e) =>
                      setHours(
                        day,
                        e.target.checked
                          ? { open: "08:00", close: "18:00" }
                          : null
                      )
                    }
                    className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                  />
                  {label}
                </label>
                {hours ? (
                  <div className="flex items-center gap-2 text-sm">
                    <input
                      type="time"
                      value={hours.open}
                      onChange={(e) =>
                        setHours(day, { ...hours, open: e.target.value })
                      }
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                    />
                    <span className="text-gray-400">to</span>
                    <input
                      type="time"
                      value={hours.close}
                      onChange={(e) =>
                        setHours(day, { ...hours, close: e.target.value })
                      }
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                    />
                  </div>
                ) : (
                  <span className="text-sm text-gray-400">Closed</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* What can be booked */}
      <div className="rounded-xl border border-gray-200 p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            Bookable visit types
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Uncheck anything you don't want offered online.
          </p>
        </div>
        {allTypes.length === 0 ? (
          <p className="text-sm text-gray-500">
            No appointment types yet. Add them in the Appointment Types tab.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {allTypes.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={bookableSet === null || bookableSet.has(t.id)}
                  onChange={() => toggleType(t.id)}
                  className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                />
                {t.name}
                <span className="text-gray-400">({t.durationMinutes} min)</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Rules */}
      <div className="rounded-xl border border-gray-200 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900">Booking rules</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Minimum notice
            </label>
            <select
              value={config.leadTimeMinutes}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  leadTimeMinutes: Number(e.target.value),
                }))
              }
              className={inputClass}
            >
              {LEAD_TIME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              How far ahead
            </label>
            <select
              value={config.bookingWindowDays}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  bookingWindowDays: Number(e.target.value),
                }))
              }
              className={inputClass}
            >
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={config.allowNewClients}
            onChange={(e) =>
              setConfig((c) => ({ ...c, allowNewClients: e.target.checked }))
            }
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
          />
          <span>
            Let new clients book
            <span className="block text-xs text-gray-500">
              New clients and their pets are added to your records automatically.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={config.autoConfirm}
            onChange={(e) =>
              setConfig((c) => ({ ...c, autoConfirm: e.target.checked }))
            }
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
          />
          <span>
            Confirm bookings automatically
            <span className="block text-xs text-gray-500">
              Off means bookings arrive as requests your team confirms.
            </span>
          </span>
        </label>
      </div>

      {/* Look and feel */}
      <div className="rounded-xl border border-gray-200 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900">Look and feel</h3>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Welcome message <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            value={config.welcomeText}
            onChange={(e) =>
              setConfig((c) => ({ ...c, welcomeText: e.target.value }))
            }
            rows={2}
            maxLength={BOOKING_WELCOME_MAX_LENGTH}
            placeholder="A short hello shown at the top of your page"
            className={`${inputClass} resize-none`}
          />
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-gray-700">Accent color</label>
          <input
            type="color"
            value={config.accentColor}
            onChange={(e) =>
              setConfig((c) => ({ ...c, accentColor: e.target.value }))
            }
            className="h-8 w-14 cursor-pointer rounded border border-gray-300"
          />
        </div>
      </div>

      {/* QR code, only when live */}
      {isLive && (
        <div className="rounded-xl border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">QR code</h3>
          <p className="text-xs text-gray-500 mb-3">
            Print it for your front desk. Clients scan it to book.
          </p>
          <div className="inline-block rounded-lg bg-white p-3 border border-gray-100">
            <QRCodeSVG value={liveUrl} size={144} />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          onClick={() => handleSave(true)}
          disabled={!slugValid || slugTaken || save.isPending}
        >
          {save.isPending && published ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : null}
          {isLive ? "Save changes" : "Publish page"}
        </Button>
        {isLive ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => handleSave(false)}
            disabled={save.isPending}
          >
            Unpublish
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => handleSave(false)}
            disabled={!slugValid || slugTaken || save.isPending}
          >
            Save draft
          </Button>
        )}
        {published && !isLive && !save.isPending && (
          <span className="text-xs text-gray-500">
            Publishing makes your page public right away.
          </span>
        )}
      </div>
    </div>
  );
}
