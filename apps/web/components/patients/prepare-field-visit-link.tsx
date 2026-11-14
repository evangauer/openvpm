"use client";

import { useSession } from "next-auth/react";
import { WifiOff } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fieldVisitHref } from "@/lib/offline/field-navigation";
import { Button } from "@/components/ui/button";

export function PrepareFieldVisitLink({
  patientId,
  appointmentId,
  doctorId,
}: {
  patientId: string;
  appointmentId?: string;
  doctorId?: string | null;
}) {
  const { data: session } = useSession();
  const eligible =
    session?.user?.role === "admin" &&
    (!appointmentId || doctorId === session.user.id);
  const { data } = trpc.offlineField.availability.useQuery(undefined, {
    enabled: eligible,
    staleTime: 300_000,
    retry: false,
  });
  if (!eligible || !data?.enabled) return null;
  return (
    <Button size="sm" variant="outline" asChild>
      <a href={fieldVisitHref(patientId, appointmentId)}>
        <WifiOff className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Prepare for field visit
      </a>
    </Button>
  );
}
