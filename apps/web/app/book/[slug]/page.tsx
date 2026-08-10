"use client";

import { useEffect, useId, useMemo, useState } from "react";
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
  const formId = useId();
  const typeFieldId = `${formId}-type`;
  const locationFieldId = `${formId}-location`;
  const dateFieldId = `${formId}-date`;
  const firstNameFieldId = `${formId}-first-name`;
  const lastNameFieldId = `${formId}-last-name`;
  const emailFieldId = `${formId}-email`;
  const phoneFieldId = `${formId}-phone`;
  const websiteFieldId = `${formId}-website`;
  const petNameFieldId = `${formId}-pet-name`;
  const speciesFieldId = `${formId}-species`;
  const reasonFieldId = `${formId}-reason`;

  const page = trpc.booking.getPage.useQuery({ slug }, { enabled: !!slug });
  const book = trpc.booking.book.useMutation();

  const [typeId, setTypeId] = useState("");
  const [locationId, setLocationId] = useState("");
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
    { slug, date, typeId, locationId: locationId || undefined },
    { enabled: !!slug && !!date && !!typeId && !!locationId }
  );

  useEffect(() => {
    if (page.data?.locations.length === 1 && !locationId) {
      setLocationId(page.data.locations[0]!.id);
    }
  }, [locationId, page.data]);

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
        title="This appointment request page isn't available"
        description="The link may be incorrect, or online appointment requests may be turned off. Please contact the clinic directly."
      />
    );
  }

  const data = page.data;
  const accent = data.accentColor;
  const selectedType = data.types.find((t) => t.id === typeId);
  const selectedLocation = data.locations.find(
    (item) => item.id === locationId,
  );
  const canSubmit = Boolean(
    date &&
    time &&
    typeId &&
    selectedLocation &&
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
      typeId,
      locationId,
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
        <h1 className="text-xl font-bold text-gray-900 mb-2">Request sent!</h1>
        <p className="text-gray-600 max-w-sm mx-auto">{book.data.message}</p>
        <div className="mx-auto mt-5 max-w-sm rounded-xl border border-gray-200 bg-gray-50 p-4 text-left text-sm">
          <p className="mb-3 font-semibold text-gray-900">
            Requested — not yet confirmed
          </p>
          <dl className="space-y-2 text-gray-600">
            <div className="flex justify-between gap-4">
              <dt>Pet</dt>
              <dd className="font-medium text-gray-900">{petName}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Visit</dt>
              <dd className="font-medium text-gray-900">
                {selectedType?.name ?? "Appointment"}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Preferred time</dt>
              <dd className="font-medium text-gray-900">{date} at {time}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Clinic</dt>
              <dd className="text-right font-medium text-gray-900">
                {selectedLocation?.name ?? data.practice.name}
              </dd>
            </div>
          </dl>
        </div>
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
              {[
                selectedLocation?.address ?? data.practice.address,
                data.practice.phone,
              ]
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
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Request an appointment
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Choose a preferred time. The clinic will review your request and
            confirm the appointment with you.
          </p>
        </div>

        {data.locations.length > 1 ? (
          <div>
            <label
              htmlFor={locationFieldId}
              className="block text-sm font-medium text-gray-700 mb-1.5"
            >
              Clinic location
            </label>
            <select
              id={locationFieldId}
              value={locationId}
              onChange={(event) => {
                setLocationId(event.target.value);
                setTime("");
              }}
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="" disabled>
                Choose a location
              </option>
              {data.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
            {selectedLocation?.address ? (
              <p className="mt-1 text-xs text-gray-500">
                {selectedLocation.address}
              </p>
            ) : null}
          </div>
        ) : data.locations[0] ? (
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">
            <span className="font-medium text-gray-800">
              {data.locations[0].name}
            </span>
            {data.locations[0].address ? ` · ${data.locations[0].address}` : ""}
          </p>
        ) : null}

        <div>
          <label
            htmlFor={typeFieldId}
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            What do you need?
          </label>
          <select
            id={typeFieldId}
            value={typeId}
            onChange={(e) => {
              setTypeId(e.target.value);
              setTime("");
            }}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          >
            <option value="" disabled>
              Choose a visit type
            </option>
            {data.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.durationMinutes} min)
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={dateFieldId}
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            Pick a day
          </label>
          <input
            id={dateFieldId}
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

        {date && typeId && locationId && (
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 mb-2">
              Pick a time
            </legend>
            {slots.isLoading && (
              <p className="text-xs text-gray-500">Checking suggested times…</p>
            )}
            {!slots.isLoading && slots.error && (
              <p className="text-xs text-red-600">
                Suggested times could not be loaded. Please try again.
              </p>
            )}
            {!slots.isLoading && !slots.error && slots.data && slots.data.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <CalendarX2 className="h-4 w-4" />
                No suggested request times that day. Try another date.
              </div>
            )}
            {!slots.isLoading && !slots.error && slots.data && slots.data.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {slots.data.map((s) => {
                  const selected = time === s.time;
                  return (
                    <label key={s.iso} className="cursor-pointer">
                      <input
                        type="radio"
                        name={`${formId}-time`}
                        value={s.time}
                        checked={selected}
                        onChange={() => setTime(s.time)}
                        required
                        className="peer sr-only"
                      />
                      <span
                        className={`block rounded-md border px-3 py-1.5 text-sm transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2 ${
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
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
        )}

        <div className="border-t border-gray-100 pt-5 space-y-4">
          <p className="text-sm font-semibold text-gray-900">About you</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor={firstNameFieldId}
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                First name
              </label>
              <input
                id={firstNameFieldId}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                maxLength={128}
                autoComplete="given-name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div>
              <label
                htmlFor={lastNameFieldId}
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Last name
              </label>
              <input
                id={lastNameFieldId}
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
              <label
                htmlFor={emailFieldId}
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Email
              </label>
              <input
                id={emailFieldId}
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
              <label
                htmlFor={phoneFieldId}
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Phone <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                id={phoneFieldId}
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
            <label htmlFor={websiteFieldId}>
              Website
              <input
                id={websiteFieldId}
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor={petNameFieldId}
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Pet's name
              </label>
              <input
                id={petNameFieldId}
                value={petName}
                onChange={(e) => setPetName(e.target.value)}
                required
                maxLength={128}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div>
              <label
                htmlFor={speciesFieldId}
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Pet type
              </label>
              <select
                id={speciesFieldId}
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
            <label
              htmlFor={reasonFieldId}
              className="block text-sm font-medium text-gray-700 mb-1.5"
            >
              What's this visit about?
            </label>
            <textarea
              id={reasonFieldId}
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
            ? "Sending request…"
            : selectedType
              ? `Request ${selectedType.name}`
              : "Request appointment"}
        </button>
        <p className="text-center text-xs text-gray-400">
          Prefer to talk to a person?
          {data.practice.phone ? ` Call ${data.practice.phone}.` : " Contact the clinic."}
        </p>
      </form>
    </div>
  );
}
