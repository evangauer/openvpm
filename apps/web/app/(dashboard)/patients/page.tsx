"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Search, Plus, PawPrint, GitMerge } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import { TableSkeleton } from "@/components/common/loading";
import { PATIENT_SEARCH_MAX_LENGTH } from "@/lib/patients/policy";

const speciesEmoji: Record<string, string> = {
  canine: "\uD83D\uDC36",
  feline: "\uD83D\uDC31",
  avian: "\uD83D\uDC26",
  rabbit: "\uD83D\uDC30",
  reptile: "\uD83E\uDD8E",
  equine: "\uD83D\uDC34",
  other: "\uD83D\uDC3E",
};

type SpeciesFilter =
  | ""
  | "canine"
  | "feline"
  | "avian"
  | "rabbit"
  | "reptile"
  | "equine"
  | "other";

const speciesOptions: Array<{ value: SpeciesFilter; label: string }> = [
  { value: "", label: "All Species" },
  { value: "canine", label: "Canine" },
  { value: "feline", label: "Feline" },
  { value: "avian", label: "Avian" },
  { value: "rabbit", label: "Rabbit" },
  { value: "reptile", label: "Reptile" },
  { value: "equine", label: "Equine" },
  { value: "other", label: "Other" },
];

function canManagePatientsRole(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

function formatSex(sex: string | null): string {
  if (!sex) return "\u2014";
  const labels: Record<string, string> = {
    male: "M",
    female: "F",
    male_neutered: "MN",
    female_spayed: "FS",
  };
  return labels[sex] ?? sex;
}

export default function PatientsPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [search, setSearch] = useState("");
  const [species, setSpecies] = useState<SpeciesFilter>("");
  const trimmedSearch = search.trim();
  const hasSearch = trimmedSearch.length > 0;
  const hasFilters = hasSearch || Boolean(species);
  const canManagePatients = canManagePatientsRole(session?.user?.role);
  const canReviewDuplicates = session?.user?.role === "admin";

  const { data, isLoading, error } = trpc.patients.list.useQuery({
    search: hasSearch ? trimmedSearch : undefined,
    species: species || undefined,
    limit: 25,
    offset: 0,
  });
  const patientsMissing = !isLoading && !error && !data;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold">Patients</h2>
          <p className="text-sm text-muted-foreground">
            Manage patient records
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canReviewDuplicates ? (
            <Button
              variant="outline"
              onClick={() => router.push("/patients/duplicates")}
            >
              <GitMerge className="mr-2 h-4 w-4" />
              Review duplicates
            </Button>
          ) : null}
          {canManagePatients && (
            <Button onClick={() => router.push("/patients/new")}>
              <Plus className="mr-2 h-4 w-4" />
              New Patient
            </Button>
          )}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search patients..."
            value={search}
            maxLength={PATIENT_SEARCH_MAX_LENGTH}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <select
          value={species}
          onChange={(e) => setSpecies(e.target.value as SpeciesFilter)}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {speciesOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.total} patient{data.total !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {error || patientsMissing ? (
        <div className="mt-6 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {error?.message ?? "Unable to load patients. Please retry."}
        </div>
      ) : isLoading ? (
        <TableSkeleton rows={8} cols={5} />
      ) : data && data.items.length > 0 ? (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Name
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Breed
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Owner
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Sex
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((patient) => (
                <tr
                  key={patient.id}
                  onClick={() => router.push(`/patients/${patient.id}`)}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                >
                  <td className="px-4 py-3 font-medium">
                    <span className="mr-1.5">
                      {speciesEmoji[patient.species ?? "other"] ?? "\uD83D\uDC3E"}
                    </span>
                    {patient.name}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {patient.breed || "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {patient.clientFirstName && patient.clientLastName
                      ? `${patient.clientFirstName} ${patient.clientLastName}`
                      : "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatSex(patient.sex)}
                  </td>
                  <td className="px-4 py-3">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          className="mt-6"
          icon={PawPrint}
          title={hasFilters ? "No patients match your filters" : "No patients yet"}
          description={
            hasFilters
              ? "Clear the search or species filter to broaden the list."
              : "Create a patient record once the owner client is in OpenVPM."
          }
          action={
            !hasFilters && canManagePatients
              ? {
                  label: "Add your first patient",
                  onClick: () => router.push("/patients/new"),
                  icon: Plus,
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
