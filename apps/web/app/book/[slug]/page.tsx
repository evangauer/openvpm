"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, CalendarX2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { EmptyState } from "@/components/common/empty-state";
import { BOOKING_REASON_MAX_LENGTH } from "@/lib/booking/page-config";

const SPECIES_OPTIONS = [
  { value: "canine", label: "Dog" },
  { value: "feline", label: "Cat" },
  { value: "avian", label: "Bird" },
  { value: "rabbit", label: "Rabbit" },
  { value: "reptile", label: "Reptile" },
  { value: "equine", label: "Horse" },
  { value: "other", label: "Other" },
] as const;

type SpeciesValue = (typeof SPECIES_OPTIONS)[number]["value"];

function dateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function PublicBookingPage() {
  const params = useParams();
  const slug = (params.slug as string) ?? "";

  const page = trpc.booking.getPage.useQuery({ slug }, { enabled: !!slug });
  const book = trpc.booking.book.useMutation();

  const [typeId, setTypeId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [petName, setPetName] = useState("");
  const [species, setSpecies] = useState<SpeciesValue>("canine");
  const [reason, setReason] = useState("");
  // Honeypot: hidden from humans, filled by bots.
  const [website, setWebsite] = useState("");

  const slots = trpc.booking.availableSlots.useQuery(
    { slug, date, typeId: typeId || undefined },
    { enabled: !!slug && !!date }
  );

  const dateBounds = useMemo(() => {
    if (!page.data) return null;
    const now = new Date();
    const max = new Date(
      now.getTime() + page.data.bookingWindowDays * 24 * 60 * 60 * 1000
    );
    return { min: dateInputValue(now), max: dateInputValue(max) };
  }, [page.data]);

  if (page.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-teal-600 border-t-transparent" />
      </div>
    );
  }

  if (page.error || !page.data) {
    return (
      <EmptyState
        className="py-16"
        icon={AlertCircle}
        title="This booking page isn't available"
        description="The link may be incorrect, or online booking may be turned off. Please contact the clinic directly."
      />
    );
  }

  const data = page.data;
  const accent = data.accentColor;
  const selectedType = data.types.find((t) => t.id === typeId);
  const canSubmit = Boolean(
    date &&
      time &&
      firstName.trim() &&
      lastName.trim() &&
      email.trim() &&
      petName.trim() &&
      reason.trim() &&
      !book.isPending
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    book.mutate({
      slug,
      typeId: typeId || undefined,
      date,
      time,
      contact: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
      },
      pet: { name: petName.trim(), species },
      reason: reason.trim(),
      website,
    });
  }

  if (book.data?.success) {
    return (
      <div className="rounded-2xl bg-white p-8 shadow-sm text-center">
        <div
          className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full text-white"
          style={{ backgroundColor: accent }}
        >
          <svg
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          {book.data.requiresConfirmation ? "Request sent!" : "You're booked!"}
        </h1>
        <p className="text-gray-600 max-w-sm mx-auto">{book.data.message}</p>
        <p className="text-gray-500 text-sm mt-4">
          We sent the details to the clinic. Questions?{" "}
          {data.practice.phone ? `Call ${data.practice.phone}.` : "Contact the clinic."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="rounded-2xl bg-white p-6 shadow-sm">
        <div className="flex items-center gap-4">
          {data.practice.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.practice.logoUrl}
              alt=""
              className="h-14 w-14 rounded-xl object-cover"
            />
          ) : (
            <div
              className="flex h-14 w-14 items-center justify-center rounded-xl text-xl font-bold text-white"
              style={{ backgroundColor: accent }}
            >
              {data.practice.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="text-xl font-bold text-gray-900">{data.practice.name}</h1>
            <p className="text-sm text-gray-500">
              {[data.practice.address, data.practice.phone]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
        {data.welcomeText && (
          <p className="mt-4 text-sm text-gray-600">{data.welcomeText}</p>
        )}
      </header>

      <form onSubmit={submit} className="rounded-2xl bg-white p-6 shadow-sm space-y-5">
        <h2 className="text-base font-semibold text-gray-900">Book an appointment</h2>

        {data.types.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              What do you need?
            </label>
            <select
              value={typeId}
              onChange={(e) => {
                setTypeId(e.target.value);
                setTime("");
              }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="">General visit (30 min)</option>
              {data.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.durationMinutes} min)
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Pick a day
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setTime("");
            }}
            min={dateBounds?.min}
            max={dateBounds?.max}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
        </div>

        {date && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Pick a time</p>
            {slots.isLoading && (
              <p className="text-xs text-gray-500">Checking open times…</p>
            )}
            {!slots.isLoading && slots.error && (
              <p className="text-xs text-red-600">
                Open times could not be loaded. Please try again.
              </p>
            )}
            {!slots.isLoading && !slots.error && slots.data && slots.data.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <CalendarX2 className="h-4 w-4" />
                No open times that day. Try another date.
              </div>
            )}
            {!slots.isLoading && !slots.error && slots.data && slots.data.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {slots.data.map((s) => {
                  const selected = time === s.time;
                  return (
                    <button
                      key={s.iso}
                      type="button"
                      onClick={() => setTime(s.time)}
                      className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                        selected
                          ? "text-white"
                          : "border-gray-200 text-gray-600 hover:border-gray-400"
                      }`}
                      style={
                        selected
                          ? { backgroundColor: accent, borderColor: accent }
                          : undefined
                      }
                    >
                      {s.time}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="border-t border-gray-100 pt-5 space-y-4">
          <p className="text-sm font-semibold text-gray-900">About you</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                First name
              </label>
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                maxLength={128}
                autoComplete="given-name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Last name
              </label>
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                maxLength={128}
                autoComplete="family-name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={255}
                autoComplete="email"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Phone <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={32}
                autoComplete="tel"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
          </div>

          {/* Honeypot: invisible to humans, present for bots. */}
          <div className="absolute -left-[9999px] top-auto" aria-hidden="true">
            <label>
              Website
              <input
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Pet's name
              </label>
              <input
                value={petName}
                onChange={(e) => setPetName(e.target.value)}
                required
                maxLength={128}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Pet type
              </label>
              <select
                value={species}
                onChange={(e) => setSpecies(e.target.value as SpeciesValue)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                {SPECIES_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              What's this visit about?
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              rows={3}
              maxLength={BOOKING_REASON_MAX_LENGTH}
              placeholder="Tell us a little about what your pet needs"
              className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>
        </div>

        {book.error && <p className="text-sm text-red-600">{book.error.message}</p>}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 transition-opacity"
          style={{ backgroundColor: accent }}
        >
          {book.isPending
            ? "Booking…"
            : selectedType
              ? `Book ${selectedType.name}`
              : "Book appointment"}
        </button>
        <p className="text-center text-xs text-gray-400">
          Prefer to talk to a person?
          {data.practice.phone ? ` Call ${data.practice.phone}.` : " Contact the clinic."}
        </p>
      </form>
    </div>
  );
}
