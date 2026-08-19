"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { Check, Copy, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

type Enrollment = {
  secret: string;
  provisioningUri: string;
};

function MutationError({ message }: { message?: string }) {
  return message ? (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  ) : null;
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      toast.success("Recovery codes copied");
    } catch {
      toast.error("Could not copy recovery codes");
    }
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/30">
      <h2 className="font-heading text-lg font-semibold">Save these recovery codes</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Each code works once. Store them in a password manager; OpenVPM cannot
        show them again.
      </p>
      <div className="mt-4 grid gap-2 rounded-lg border bg-background p-4 font-mono text-sm sm:grid-cols-2">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={copyCodes}>
          {copied ? (
            <Check className="mr-2 h-4 w-4" />
          ) : (
            <Copy className="mr-2 h-4 w-4" />
          )}
          {copied ? "Copied" : "Copy codes"}
        </Button>
        <Button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          I saved them — sign in again
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Your other OpenVPM sessions have already been revoked.
      </p>
    </div>
  );
}

function SensitiveActionConfirmation({ mfaEnabled }: { mfaEnabled: boolean }) {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch("/api/auth/step-up", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { active?: boolean };
        if (mounted) setActive(response.ok && body.active === true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/step-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, code }),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) {
        setError(body.message ?? "Identity confirmation failed.");
        return;
      }
      setPassword("");
      setCode("");
      setActive(true);
      toast.success("Sensitive actions unlocked for 10 minutes");
    } catch {
      setError("Identity confirmation is temporarily unavailable.");
    } finally {
      setSubmitting(false);
    }
  }

  async function clear() {
    await fetch("/api/auth/step-up", { method: "DELETE" });
    setActive(false);
  }

  return (
    <section className="rounded-xl border bg-card p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <KeyRound className="h-5 w-5" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold">
            Sensitive actions
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Reconfirm your identity before refunds, payment-account changes,
            staff access changes, bulk exports, or credential changes.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking recent confirmation...
        </p>
      ) : active ? (
        <div className="mt-5 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
          <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
            Identity recently confirmed
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Sensitive actions are available for up to 10 minutes in this
            browser. The proof is tied to this account and session.
          </p>
          <Button className="mt-3" type="button" variant="outline" onClick={clear}>
            End confirmation now
          </Button>
        </div>
      ) : !mfaEnabled ? (
        <p className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Enable two-step verification above before performing sensitive
          actions in hosted OpenVPM.
        </p>
      ) : (
        <form className="mt-5 space-y-3 border-t pt-5" onSubmit={confirm}>
          <Input
            className="max-w-sm"
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <Input
            className="max-w-sm"
            autoComplete="one-time-code"
            placeholder="Fresh authenticator or recovery code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <MutationError message={error ?? undefined} />
          <Button type="submit" disabled={!password || !code || submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm for 10 minutes
          </Button>
        </form>
      )}
    </section>
  );
}

export default function AccountSecurityPage() {
  const utils = trpc.useUtils();
  const status = trpc.auth.mfaStatus.useQuery();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [managementOpen, setManagementOpen] = useState<
    "recovery" | "disable" | null
  >(null);

  const begin = trpc.auth.beginMfaEnrollment.useMutation({
    onSuccess: (result) => {
      setEnrollment({
        secret: result.secret,
        provisioningUri: result.provisioningUri,
      });
      setPassword("");
      setCode("");
    },
  });
  const confirm = trpc.auth.confirmMfaEnrollment.useMutation({
    onSuccess: (result) => {
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(null);
      setCode("");
    },
  });
  const regenerate = trpc.auth.regenerateMfaRecoveryCodes.useMutation({
    onSuccess: (result) => {
      setRecoveryCodes(result.recoveryCodes);
      setPassword("");
      setCode("");
      setManagementOpen(null);
    },
  });
  const disable = trpc.auth.disableMfa.useMutation({
    onSuccess: async () => {
      toast.success("Two-step verification disabled");
      await signOut({ callbackUrl: "/login" });
    },
  });

  if (status.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading account security...
      </div>
    );
  }

  if (status.error || !status.data) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border bg-card p-6">
        <h1 className="font-heading text-xl font-semibold">Account Security</h1>
        <p className="mt-2 text-sm text-destructive" role="alert">
          {status.error?.message ?? "Could not load account security."}
        </p>
        <Button
          className="mt-4"
          variant="outline"
          onClick={() => void status.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (recoveryCodes) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Account Security</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Protect access to clinic and client information.
          </p>
        </div>
        <RecoveryCodes codes={recoveryCodes} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Account Security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Protect access to clinic and client information.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading text-lg font-semibold">
                Two-step verification
              </h2>
              <span
                className={
                  status.data.enabled
                    ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                    : "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                }
              >
                {status.data.enabled ? "Protected" : "Not enabled"}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Use an authenticator app such as 1Password, Google Authenticator,
              or Microsoft Authenticator when you sign in.
            </p>
          </div>
        </div>

        {!status.data.available ? (
          <p className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            Two-step verification is not configured on this deployment. An
            OpenVPM operator must configure the encryption key before it can be
            enabled.
          </p>
        ) : status.data.enabled ? (
          <div className="mt-5 space-y-4 border-t pt-5">
            <p className="text-sm text-muted-foreground">
              {status.data.recoveryCodesRemaining} recovery code
              {status.data.recoveryCodesRemaining === 1 ? "" : "s"} remaining.
              Changing this protection signs your account out on every device.
            </p>
            {!managementOpen ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setManagementOpen("recovery")}
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  Replace recovery codes
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setManagementOpen("disable")}
                >
                  Disable two-step verification
                </Button>
              </div>
            ) : (
              <form
                className="space-y-3 rounded-lg border p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = { password, code };
                  if (managementOpen === "recovery") regenerate.mutate(input);
                  else disable.mutate(input);
                }}
              >
                <h3 className="text-sm font-semibold">
                  {managementOpen === "recovery"
                    ? "Replace recovery codes"
                    : "Disable two-step verification"}
                </h3>
                <p className="text-xs text-muted-foreground">
                  Confirm your current password and a fresh authenticator or
                  recovery code.
                </p>
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Current password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <Input
                  inputMode="text"
                  autoComplete="one-time-code"
                  placeholder="6-digit or recovery code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
                <MutationError
                  message={(regenerate.error ?? disable.error)?.message}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    variant={
                      managementOpen === "disable" ? "destructive" : "default"
                    }
                    disabled={
                      !password ||
                      !code ||
                      regenerate.isPending ||
                      disable.isPending
                    }
                  >
                    {(regenerate.isPending || disable.isPending) && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setManagementOpen(null);
                      setPassword("");
                      setCode("");
                      regenerate.reset();
                      disable.reset();
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </div>
        ) : enrollment ? (
          <div className="mt-5 space-y-5 border-t pt-5">
            <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-center">
              <div className="w-fit rounded-xl border bg-white p-3">
                <QRCodeSVG
                  value={enrollment.provisioningUri}
                  size={176}
                  level="M"
                  title="OpenVPM authenticator setup code"
                />
              </div>
              <div>
                <h3 className="text-sm font-semibold">
                  1. Scan with your authenticator app
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  If you cannot scan the image, enter this setup key manually:
                </p>
                <code className="mt-2 block break-all rounded-md border bg-muted px-3 py-2 text-xs">
                  {enrollment.secret}
                </code>
              </div>
            </div>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                confirm.mutate({ code });
              }}
            >
              <div>
                <label htmlFor="mfa-confirm-code" className="text-sm font-medium">
                  2. Enter the 6-digit code
                </label>
                <Input
                  id="mfa-confirm-code"
                  className="mt-1 max-w-xs"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="123456"
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  autoFocus
                  required
                />
              </div>
              <MutationError message={confirm.error?.message} />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={code.length !== 6 || confirm.isPending}
                >
                  {confirm.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Verify and enable
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEnrollment(null);
                    setCode("");
                    confirm.reset();
                    void utils.auth.mfaStatus.invalidate();
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        ) : (
          <form
            className="mt-5 space-y-3 border-t pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              begin.mutate({ password });
            }}
          >
            <label htmlFor="mfa-current-password" className="text-sm font-medium">
              Confirm your password to begin
            </label>
            <Input
              id="mfa-current-password"
              className="max-w-sm"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <MutationError message={begin.error?.message} />
            <Button type="submit" disabled={!password || begin.isPending}>
              {begin.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Set up authenticator
            </Button>
          </form>
        )}
      </section>

      <SensitiveActionConfirmation mfaEnabled={status.data.enabled} />

      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-heading text-lg font-semibold">Active sessions</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          If a device is lost or a sign-in looks unfamiliar, use the shield icon
          beside your name in the navigation to sign out every device.
        </p>
      </section>
    </div>
  );
}
