"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  CalendarClock,
  CalendarPlus,
  History,
  MapPin,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { EmptyState } from "@/components/common/empty-state";
import { splitPortalAppointments } from "@/lib/portal/appointments";
import { formatPortalDateTime } from "@/lib/portal/date";

const statusStyles: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-700",
  confirmed: "bg-teal-100 text-teal-700",
  checked_in: "bg-amber-100 text-amber-700",
  in_exam: "bg-purple-100 text-purple-700",
  checked_out: "bg-green-100 text-green-700",
  no_show: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

const speciesEmoji: Record<string, string> = {
  canine: "🐶",
  feline: "🐱",
  avian: "🐦",
  rabbit: "🐇",
  reptile: "🦎",
  equine: "🐴",
  other: "🐾",
};

function formatDateTime(d: string | Date, timeZone?: string | null): string {
  return formatPortalDateTime(d, undefined, timeZone);
}

function formatStatusLabel(status: string): string {
  // `scheduled` is the internal state for a request that clinic staff have
  // not yet confirmed with the owner. Never present it as a firm appointment.
  if (status === "scheduled") return "Requested — awaiting confirmation";
  // Pet-owner wording: "checked out" is clinic jargon.
  if (status === "checked_out") return "Completed";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function AppointmentsPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const { data, isLoading, error } = trpc.portal.getAppointments.useQuery({ token });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-teal-600 border-t-transparent" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-xl">
        <EmptyState
          className="py-12"
          icon={AlertCircle}
          title="Unable to load appointments"
          description="Please refresh this page or contact your clinic if the portal link has expired."
        />
      </div>
    );
  }

  const { upcoming, past } = splitPortalAppointments(data);

  return (
    <div>
      <Link
        href={`/portal/${token}`}
        className="inline-flex items-center gap-1 text-sm text-teal-600 hover:text-teal-700 mb-6"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to portal
      </Link>

      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Appointments</h1>
        <Link
          href={`/portal/${token}/book`}
          className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Request appointment
        </Link>
      </div>

      {/* Upcoming and active */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-teal-500" />
          Upcoming and requests
        </h2>
        {upcoming.length === 0 ? (
          <EmptyState
            className="py-10"
            icon={CalendarClock}
            title="No upcoming appointments or requests"
            action={{
              label: "Request appointment",
              onClick: () => router.push(`/portal/${token}/book`),
              icon: CalendarPlus,
            }}
          />
        ) : (
          <div className="space-y-3">
            {upcoming.map((appt) => (
              <div
                key={appt.id}
                className="rounded-xl border border-gray-200 p-4 hover:border-teal-200 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-gray-900">
                      {formatDateTime(appt.startTime, appt.timezone)}
                    </p>
                    <p className="text-sm text-gray-600 mt-1">
                      {appt.patientSpecies && (
                        <span className="mr-1">{speciesEmoji[appt.patientSpecies] || "🐾"}</span>
                      )}
                      {appt.patientName || "No patient"}
                      {appt.typeName && (
                        <span className="text-gray-400"> &middot; {appt.typeName}</span>
                      )}
                    </p>
                    {appt.doctorName && (
                      <p className="text-sm text-gray-400 mt-0.5">
                        with {appt.doctorName}
                      </p>
                    )}
                    {appt.locationName && (
                      <p className="mt-0.5 flex items-center gap-1 text-sm text-gray-400">
                        <MapPin className="h-3.5 w-3.5" />
                        {appt.locationName}
                      </p>
                    )}
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium flex-shrink-0 ${
                      statusStyles[appt.status] || "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {formatStatusLabel(appt.status)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Past */}
      <section>
        <h2 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-gray-400" />
          Past
        </h2>
        {past.length === 0 ? (
          <EmptyState
            className="py-10"
            icon={History}
            title="No past appointments"
          />
        ) : (
          <div className="space-y-3">
            {past.map((appt) => (
              <div
                key={appt.id}
                className="rounded-xl border border-gray-100 p-4 bg-gray-50/50"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-gray-700">
                      {formatDateTime(appt.startTime, appt.timezone)}
                    </p>
                    <p className="text-sm text-gray-500 mt-1">
                      {appt.patientSpecies && (
                        <span className="mr-1">{speciesEmoji[appt.patientSpecies] || "🐾"}</span>
                      )}
                      {appt.patientName || "No patient"}
                      {appt.typeName && (
                        <span className="text-gray-400"> &middot; {appt.typeName}</span>
                      )}
                    </p>
                    {appt.doctorName && (
                      <p className="text-sm text-gray-400 mt-0.5">
                        with {appt.doctorName}
                      </p>
                    )}
                    {appt.locationName && (
                      <p className="mt-0.5 flex items-center gap-1 text-sm text-gray-400">
                        <MapPin className="h-3.5 w-3.5" />
                        {appt.locationName}
                      </p>
                    )}
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium flex-shrink-0 ${
                      statusStyles[appt.status] || "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {formatStatusLabel(appt.status)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
