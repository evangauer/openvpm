"use client";

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  SETTINGS_EMAIL_MAX_LENGTH,
  STAFF_NAME_MAX_LENGTH,
} from "@/lib/settings-policy";
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

const MAX_ROWS = 10;

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

interface Row {
  name: string;
  email: string;
  role: Role;
}

function emptyRow(): Row {
  return { name: "", email: "", role: "front_desk" };
}

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
 * Step 3: invite teammates by email. Starts with a single row; "Add another"
 * appends more (up to MAX_ROWS). Continue sends one invite per valid email and
 * reports a short summary. Empty rows are skipped, so the step is fully optional.
 */
export function InviteTeamStep({
  register,
}: {
  register: (h: StepHandle) => void;
}) {
  const inviteStaff = trpc.settings.inviteStaff.useMutation();
  const [rows, setRows] = useState<Row[]>([emptyRow()]);

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
              name: row.name.trim() || undefined,
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
          toast.success(sent === 1 ? "Sent 1 invite" : `Sent ${sent} invites`);
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

  function addRow() {
    setRows((prev) => (prev.length >= MAX_ROWS ? prev : [...prev, emptyRow()]));
  }

  function removeRow(i: number) {
    setRows((prev) =>
      prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-slate-600">
        Add the people you work with. We will email them a link to set up their
        own login. Every plan includes unlimited staff.
      </p>

      <div className="space-y-3">
        {rows.map((row, i) => {
          const emailError = getInviteEmailError(row.email);
          const emailErrorId = `teammate-email-${i + 1}-error`;
          return (
            <div key={i} className="space-y-1">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_140px_auto]">
                <Input
                  type="text"
                  value={row.name}
                  maxLength={STAFF_NAME_MAX_LENGTH}
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="Name"
                  aria-label={`Teammate name ${i + 1}`}
                />
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
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  disabled={rows.length <= 1}
                  aria-label={`Remove teammate ${i + 1}`}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {emailError ? (
                <p id={emailErrorId} className="text-xs text-red-700">
                  {emailError}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {rows.length < MAX_ROWS ? (
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add another
        </Button>
      ) : null}
    </div>
  );
}
