"use client";

import Link from "next/link";
import {
  AlertCircle,
  CalendarPlus,
  MessageSquare,
  PawPrint,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { PATIENT_SPECIES_EMOJI } from "@/lib/patients/species";
import { EmptyState } from "@/components/common/empty-state";
import { calculatePortalAge } from "@/lib/portal/date";

const speciesEmoji: Record<string, string> = PATIENT_SPECIES_EMOJI;

export default function PortalHomePage() {
  const { data, isLoading, error } = trpc.portal.getClient.useQuery({});

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-xl">
        <EmptyState
          className="py-12"
          icon={AlertCircle}
          title="Unable to load portal"
          description="This portal link is invalid or has expired. Please contact your veterinary clinic for a new link."
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome, {data.firstName}!
        </h1>
        <p className="text-gray-500 mt-1">
          Here is everything about your pets in one place.
        </p>
      </div>

      {/* Pet Cards */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Your Pets</h2>
        {data.patients.length === 0 ? (
          <EmptyState
            className="py-10"
            icon={PawPrint}
            title="No pets on file yet"
            description="Your clinic will add pets here when they create patient records."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.patients.map((pet) => (
              <Link
                key={pet.id}
                href={`/portal/pets/${pet.id}`}
                className="block rounded-xl border border-gray-200 p-5 transition-all hover:border-primary/60 hover:shadow-md"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-2xl">
                    {speciesEmoji[pet.species] || "🐾"}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-gray-900 truncate">
                      {pet.name}
                    </h3>
                    <p className="text-sm text-gray-500">
                      {pet.breed || pet.species}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      {calculatePortalAge(pet.dob)}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Request Appointment */}
      <section className="mb-10">
        <Link
          href="/portal/book"
          className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/40 p-4 font-medium text-primary transition-all hover:border-primary/60 hover:bg-primary/5"
        >
          <CalendarPlus className="h-5 w-5" aria-hidden="true" />
          Request an Appointment
        </Link>
      </section>

      {/* Quick Links */}
      <section>
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Quick Links</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Link
            href="/portal/messages"
            className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 transition-all hover:border-primary/60 hover:shadow-sm"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <MessageSquare className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="font-medium text-gray-900">Messages</p>
              <p className="text-sm text-gray-500">Read and reply to your clinic</p>
            </div>
          </Link>
          <Link
            href="/portal/appointments"
            className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 transition-all hover:border-primary/60 hover:shadow-sm"
          >
            <div className="h-10 w-10 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-gray-900">Appointments</p>
              <p className="text-sm text-gray-500">View upcoming and past visits</p>
            </div>
          </Link>
          <Link
            href="/portal/invoices"
            className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 transition-all hover:border-primary/60 hover:shadow-sm"
          >
            <div className="h-10 w-10 rounded-lg bg-green-50 flex items-center justify-center text-green-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-gray-900">Invoices</p>
              <p className="text-sm text-gray-500">View billing and payments</p>
            </div>
          </Link>
        </div>
      </section>
    </div>
  );
}
