"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Clock3, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { PATIENT_SPECIES_EMOJI } from "@/lib/patients/species";

export function RecentClinicalItems({
  patientId,
  appointmentId,
  enabled,
}: {
  patientId: string;
  appointmentId?: string;
  enabled: boolean;
}) {
  const utils = trpc.useUtils();
  const recordedKey = useRef<string | null>(null);
  const recent = trpc.recentClinicalItems.list.useQuery(undefined, { enabled });
  const record = trpc.recentClinicalItems.record.useMutation({
    onSuccess: () => utils.recentClinicalItems.list.invalidate(),
  });

  useEffect(() => {
    if (!enabled) return;
    const key = `${patientId}:${appointmentId ?? "chart"}`;
    if (recordedKey.current === key) return;
    recordedKey.current = key;
    record.mutate({ patientId, appointmentId });
  }, [appointmentId, enabled, patientId, record]);

  if (!enabled) return null;

  return (
    <nav
      className="mb-4 rounded-lg border border-border bg-card px-3 py-2"
      aria-label="Recently viewed patients"
    >
      <div className="flex items-center gap-3 overflow-x-auto">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" />
          Recent
        </span>
        {recent.isLoading ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading
          </span>
        ) : recent.error ? (
          <span className="text-xs text-destructive">Unavailable</span>
        ) : recent.data?.length ? (
          recent.data.map((item) => {
            const resumeVisit =
              item.appointmentId && item.appointmentStatus === "in_exam";
            const href = resumeVisit
              ? `/encounters/${item.appointmentId}`
              : `/patients/${item.patientId}`;
            const emoji =
              PATIENT_SPECIES_EMOJI[item.patientSpecies] ??
              PATIENT_SPECIES_EMOJI.other;
            return (
              <Link
                key={item.patientId}
                href={href}
                className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full border border-border bg-background px-3 text-sm hover:border-primary/40 hover:bg-primary/5"
              >
                <span aria-hidden="true">{emoji}</span>
                <span>{item.patientName}</span>
                {resumeVisit ? (
                  <span className="text-xs font-medium text-primary">
                    In visit
                  </span>
                ) : null}
              </Link>
            );
          })
        ) : (
          <span className="text-xs text-muted-foreground">
            Open another patient to build this list.
          </span>
        )}
      </div>
    </nav>
  );
}
