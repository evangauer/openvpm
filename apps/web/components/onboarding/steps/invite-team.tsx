"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { SETTINGS_EMAIL_MAX_LENGTH } from "@/lib/settings-policy";
import { isValidEmail } from "@/lib/utils";
import { toast } from "sonner";
import type { StepHandle } from "../journey-types";

type Role = "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";

const ROLES: { value: Role; label: string }[] = [
  { value: "front_desk", label: "Front desk" },
  { value: "veterinarian", label: "Veterinarian" },
  { value: "technician", label: "Technician" },
  { value: "viewer", label: "Viewer (read only)" },
  { value: "admin", label: "Admin" },
];

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

interface Row {
  email: string;
  role: Role;
}

const EMPTY_ROWS: Row[] = [
  { email: "", role: "front_desk" },
  { email: "", role: "front_desk" },
  { email: "", role: "front_desk" },
];

function getInviteEmailError(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return null;
  if (trimmed.length > SETTINGS_EMAIL_MAX_LENGTH) {
    return `Email must be at most ${SETTINGS_EMAIL_MAX_LENGTH} characters.`;
  }
  if (!isValidEmail(trimmed)) return "Enter a valid teammate email.";
  return null;
}

function isInviteEmailValid(email: string): boolean {
  return email.trim().length > 0 && getInviteEmailError(email) === null;
}

/**
 * Step 3: invite up to three teammates by email. Continue sends one invite per
 * valid email and reports a short summary.
 */
export function InviteTeamStep({
  register,
}: {
  register: (h: StepHandle) => void;
}) {
  const inviteStaff = trpc.settings.inviteStaff.useMutation();
  const [rows, setRows] = useState<Row[]>(EMPTY_ROWS);

  useEffect(() => {
    register({
      async onContinue() {
        const invalidRows = rows.filter((r) => getInviteEmailError(r.email));
        if (invalidRows.length > 0) {
          toast.error("Fix invalid teammate emails before continuing.");
          return false;
        }

        const toInvite = rows.filter((r) => isInviteEmailValid(r.email));
        if (toInvite.length === 0) return true;

        let sent = 0;
        for (const row of toInvite) {
          try {
            await inviteStaff.mutateAsync({
              email: row.email.trim().toLowerCase(),
              role: row.role,
            });
            sent += 1;
          } catch (err) {
            toast.error(
              err instanceof Error
                ? `Could not invite ${row.email}: ${err.message}`
                : `Could not invite ${row.email}`
            );
          }
        }
        if (sent > 0) {
          toast.success(
            sent === 1 ? "Sent 1 invite" : `Sent ${sent} invites`
          );
        }
        return true;
      },
    });
  }, [register, rows, inviteStaff]);

  function update(i: number, patch: Partial<Row>) {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r))
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-slate-600">
        Add the people you work with. We will email them a link to set up their
        own login. You only pay for staff who actually use it.
      </p>

      <div className="space-y-3">
        {rows.map((row, i) => {
          const emailError = getInviteEmailError(row.email);
          const emailErrorId = `teammate-email-${i + 1}-error`;
          return (
            <div
              key={i}
              className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]"
            >
              <div className="space-y-1">
                <Input
                  type="email"
                  value={row.email}
                  maxLength={SETTINGS_EMAIL_MAX_LENGTH}
                  aria-invalid={Boolean(emailError) || undefined}
                  aria-describedby={emailError ? emailErrorId : undefined}
                  onChange={(e) => update(i, { email: e.target.value })}
                  placeholder="teammate@clinic.com"
                  aria-label={`Teammate email ${i + 1}`}
                />
                {emailError ? (
                  <p id={emailErrorId} className="text-xs text-red-700">
                    {emailError}
                  </p>
                ) : null}
              </div>
              <select
                className={selectClass}
                value={row.role}
                onChange={(e) => update(i, { role: e.target.value as Role })}
                aria-label={`Teammate role ${i + 1}`}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
