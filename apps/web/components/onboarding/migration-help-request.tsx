"use client";

import { Check, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

/**
 * Requests a hands-on migration review without asking a clinic to email PHI or
 * expose an export through a public link. The server marker is idempotent and
 * also feeds the existing activation-recovery queue.
 */
export function MigrationHelpRequest({ source }: { source: string }) {
  const utils = trpc.useUtils();
  const state = trpc.settings.getOnboardingState.useQuery();
  const request = trpc.settings.requestMigrationHelp.useMutation({
    onSuccess: async (result) => {
      utils.settings.getOnboardingState.setData(undefined, (previous) =>
        previous
          ? {
              ...previous,
              setupHelpRequestedAt:
                previous.setupHelpRequestedAt ?? result.requestedAt,
              setupHelpRequestKind: "migration",
              setupHelpMigrationSource: result.source,
              migrationHelpRequestedAt: result.requestedAt,
            }
          : previous,
      );
      await utils.settings.getOnboardingState.invalidate();
      toast.success("Migration review requested");
    },
    onError: (error) => toast.error(error.message),
  });

  const requestedAt = state.data?.migrationHelpRequestedAt ?? null;

  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-emerald-900">
            {requestedAt
              ? "Migration review requested"
              : "Want us to review the export first?"}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            {requestedAt
              ? "We will contact your clinic admin with a private transfer and review plan. Keep the files where they are until then."
              : "Request a hands-on review before importing. Do not email patient files or use an Anyone-with-the-link folder. We will contact your clinic admin with a private transfer plan."}
          </p>
          {requestedAt ? (
            <span className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-800">
              <Check className="h-3.5 w-3.5" />
              Request saved
            </span>
          ) : (
            <button
              type="button"
              onClick={() => request.mutate({ source })}
              disabled={request.isPending || state.isLoading}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            >
              {request.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Request a private migration review
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
