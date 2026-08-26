"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Activity, AlertCircle, Download, Pill, Shield } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { EmptyState } from "@/components/common/empty-state";
import {
  calculatePortalAge,
  formatPortalDate,
  portalCalendarDayDifference,
} from "@/lib/portal/date";

const speciesEmoji: Record<string, string> = {
  canine: "🐶",
  feline: "🐱",
  avian: "🐦",
  rabbit: "🐇",
  reptile: "🦎",
  equine: "🐴",
  other: "🐾",
};

function formatDate(
  d: string | Date | null,
  timeZone?: string | null
): string {
  return formatPortalDate(d, undefined, timeZone);
}

type Tab = "vaccinations" | "prescriptions" | "weights";

type PortalVaccinationForCertificate = {
  id: string;
  vaccineName: string;
  lotNumber: string | null;
  manufacturer: string | null;
  administeredAt: string | Date;
  nextDueDate: string | null;
};

function certificateFilename(patientName: string, vaccineName: string): string {
  const slug = `${patientName}-${vaccineName}-certificate`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "vaccination-certificate"}.pdf`;
}

export default function PetDetailPage() {
  const params = useParams();
  const petId = params.petId as string;
  const [activeTab, setActiveTab] = useState<Tab>("vaccinations");
  const [certificatePendingId, setCertificatePendingId] = useState<
    string | null
  >(null);
  const [certificateError, setCertificateError] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { data, isLoading, error } = trpc.portal.getPetDetail.useQuery({
    patientId: petId,
  });

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
          title="Unable to load pet information"
          description="Please refresh this page or return to the portal home."
        />
        <Link
          href="/portal"
          className="mt-4 inline-block text-sm font-medium text-primary hover:text-primary/80"
        >
          Back to portal
        </Link>
      </div>
    );
  }

  const petDetail = data;
  const practiceTimeZone = petDetail.timezone;

  async function downloadVaccinationCertificate(
    vaccination: PortalVaccinationForCertificate
  ) {
    setCertificatePendingId(vaccination.id);
    setCertificateError(null);
    try {
      // Re-authorize the exact dose at click time. Zero stale time guarantees
      // every click reaches the server even when this query key was successful.
      const certificate =
        await utils.portal.getVaccinationCertificateData.fetch(
          {
            patientId: petId,
            vaccinationRecordId: vaccination.id,
          },
          { staleTime: 0 }
        );
      const { generateVaccinationCertificatePdf } = await import("@/lib/pdf");
      const certificateTimeZone = certificate.practice.timezone;
      generateVaccinationCertificatePdf({
        practiceName: certificate.practice.name,
        practiceAddress: certificate.practice.address ?? undefined,
        practicePhone: certificate.practice.phone ?? undefined,
        practiceEmail: certificate.practice.email ?? undefined,
        patientName: certificate.patient.name,
        species: certificate.patient.species,
        breed: certificate.patient.breed ?? undefined,
        sex: certificate.patient.sex?.replace("_", " "),
        dob: certificate.patient.dob
          ? formatDate(certificate.patient.dob, certificateTimeZone)
          : undefined,
        color: certificate.patient.color ?? undefined,
        clientName: certificate.clientName,
        vaccineName: certificate.vaccination.vaccineName,
        administeredAt: formatDate(
          certificate.vaccination.administeredAt,
          certificateTimeZone
        ),
        nextDueDate: certificate.vaccination.nextDueDate
          ? formatDate(
              certificate.vaccination.nextDueDate,
              certificateTimeZone
            )
          : undefined,
        manufacturer: certificate.vaccination.manufacturer ?? undefined,
        lotNumber: certificate.vaccination.lotNumber ?? undefined,
        generatedDate: formatDate(new Date(), certificateTimeZone),
      }).save(
        certificateFilename(
          certificate.patient.name,
          certificate.vaccination.vaccineName
        )
      );
    } catch {
      setCertificateError(
        "This certificate is no longer available. Refresh to see current vaccination records."
      );
      await utils.portal.getPetDetail.invalidate({
        patientId: petId,
      });
    } finally {
      setCertificatePendingId(null);
    }
  }

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "vaccinations", label: "Vaccinations", count: data.vaccinations.length },
    { key: "prescriptions", label: "Prescriptions", count: data.prescriptions.length },
    { key: "weights", label: "Weight History", count: data.weights.length },
  ];

  function vaccinationStatus(nextDue: string | null): {
    label: string;
    className: string;
  } {
    if (!nextDue) return { label: "No due date", className: "bg-gray-100 text-gray-600" };
    const daysUntil = portalCalendarDayDifference(
      nextDue,
      new Date(),
      practiceTimeZone
    );
    if (daysUntil === null) {
      return { label: "No due date", className: "bg-gray-100 text-gray-600" };
    }
    if (daysUntil < 0) return { label: "Overdue", className: "bg-red-100 text-red-700" };
    if (daysUntil <= 30) return { label: "Due soon", className: "bg-amber-100 text-amber-700" };
    return { label: "Up to date", className: "bg-green-100 text-green-700" };
  }

  return (
    <div>
      {/* Back link */}
      <Link
        href="/portal"
        className="mb-6 inline-flex items-center gap-1 text-sm text-primary hover:text-primary/80"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to all pets
      </Link>

      {/* Pet Header */}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-3xl">
          {speciesEmoji[data.species] || "🐾"}
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{data.name}</h1>
          <p className="text-gray-500">
            {data.breed || data.species} &middot; {data.color || ""} &middot;{" "}
            {calculatePortalAge(data.dob)}
          </p>
          <p className="text-sm text-gray-400 capitalize">
            {data.sex?.replace("_", " ")}
          </p>
        </div>
      </div>

      {/* Allergy Alerts */}
      {data.allergies.length > 0 && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
          <h3 className="font-semibold text-red-800 mb-2 flex items-center gap-2">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            Allergy Alerts
          </h3>
          <ul className="space-y-1">
            {data.allergies.map((a) => (
              <li key={a.id} className="text-sm text-red-700">
                <span className="font-medium">{a.allergen}</span>
                {a.reaction && <span className="text-red-600"> - {a.reaction}</span>}
                <span
                  className={`ml-2 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                    a.severity === "severe"
                      ? "bg-red-200 text-red-800"
                      : a.severity === "moderate"
                      ? "bg-amber-200 text-amber-800"
                      : "bg-yellow-100 text-yellow-800"
                  }`}
                >
                  {a.severity}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Vaccinations Tab */}
      {activeTab === "vaccinations" && (
        <div>
          {certificateError ? (
            <p
              role="alert"
              className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {certificateError}
            </p>
          ) : null}
          {data.vaccinations.length === 0 ? (
            <EmptyState
              className="py-10"
              icon={Shield}
              title="No vaccination records yet"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500">
                    <th className="pb-2 font-medium">Vaccine</th>
                    <th className="pb-2 font-medium">Given</th>
                    <th className="pb-2 font-medium">Next Due</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Certificate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.vaccinations.map((v) => {
                    const status = vaccinationStatus(v.nextDueDate);
                    return (
                      <tr key={v.id}>
                        <td className="py-3 font-medium text-gray-900">{v.vaccineName}</td>
                        <td className="py-3 text-gray-600">
                          {formatDate(v.administeredAt, practiceTimeZone)}
                        </td>
                        <td className="py-3 text-gray-600">
                          {formatDate(v.nextDueDate, practiceTimeZone)}
                        </td>
                        <td className="py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}>
                            {status.label}
                          </span>
                        </td>
                        <td className="py-3">
                          <button
                            type="button"
                            onClick={() => void downloadVaccinationCertificate(v)}
                            disabled={certificatePendingId !== null}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden="true" />
                            {certificatePendingId === v.id
                              ? "Checking..."
                              : "Download"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Prescriptions Tab */}
      {activeTab === "prescriptions" && (
        <div>
          {data.prescriptions.length === 0 ? (
            <EmptyState
              className="py-10"
              icon={Pill}
              title="No active prescriptions"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500">
                    <th className="pb-2 font-medium">Medication</th>
                    <th className="pb-2 font-medium">Dosage</th>
                    <th className="pb-2 font-medium">Frequency</th>
                    <th className="pb-2 font-medium">Refills</th>
                    <th className="pb-2 font-medium">End Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.prescriptions.map((rx) => (
                    <tr key={rx.id}>
                      <td className="py-3 font-medium text-gray-900">{rx.medicationName}</td>
                      <td className="py-3 text-gray-600">{rx.dosage}</td>
                      <td className="py-3 text-gray-600">{rx.frequency}</td>
                      <td className="py-3 text-gray-600">{rx.refillsRemaining}</td>
                      <td className="py-3 text-gray-600">
                        {formatDate(rx.endDate, practiceTimeZone)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.prescriptions.some((rx) => rx.instructions) && (
                <div className="mt-4 space-y-2">
                  {data.prescriptions
                    .filter((rx) => rx.instructions)
                    .map((rx) => (
                      <div key={rx.id} className="rounded-lg bg-blue-50 p-3 text-sm">
                        <span className="font-medium text-blue-900">{rx.medicationName}:</span>{" "}
                        <span className="text-blue-700">{rx.instructions}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Weight History Tab */}
      {activeTab === "weights" && (
        <div>
          {data.weights.length === 0 ? (
            <EmptyState
              className="py-10"
              icon={Activity}
              title="No weight records yet"
            />
          ) : (
            <div className="space-y-3">
              {data.weights.map((w, i) => {
                const prevWeight =
                  i < data.weights.length - 1
                    ? parseFloat(data.weights[i + 1]!.weightKg)
                    : null;
                const currentWeight = parseFloat(w.weightKg);
                const diff = prevWeight !== null ? currentWeight - prevWeight : null;
                return (
                  <div
                    key={w.id}
                    className="flex items-center justify-between rounded-lg border border-gray-100 p-3"
                  >
                    <div>
                      <p className="font-medium text-gray-900">
                        {currentWeight.toFixed(1)} kg
                        <span className="ml-1 text-gray-400 text-sm">
                          ({(currentWeight * 2.205).toFixed(1)} lbs)
                        </span>
                      </p>
                      <p className="text-xs text-gray-400">
                        {formatDate(w.recordedAt, practiceTimeZone)}
                      </p>
                    </div>
                    {diff !== null && (
                      <span
                        className={`text-sm font-medium ${
                          diff > 0
                            ? "text-green-600"
                            : diff < 0
                            ? "text-red-600"
                            : "text-gray-400"
                        }`}
                      >
                        {diff > 0 ? "+" : ""}
                        {diff.toFixed(1)} kg
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
