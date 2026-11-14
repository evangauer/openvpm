import { fieldPreparationTarget } from "../lib/offline/field-navigation";
import { FieldShell, type ClinicConnection } from "./field-shell";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../server/routers/_app";
import { Button } from "../components/ui/button";
import { useOnlineStatus } from "../lib/use-online-status";
import {
  fieldTotals,
  assertFieldWorkspaceCapacity,
  fieldWorkspaceExists,
  newFieldEntry,
  openFieldWorkspace,
  parseFieldBackup,
  serializeFieldBackup,
  validateFieldSubmission,
  type FieldEntry,
  type FieldVisit,
  type FieldWorkspace,
} from "../lib/offline/field";
import type {
  EncryptedDeviceVault,
  EncryptedVaultRecovery,
} from "../lib/offline/encrypted-vault";
import { prepareOfflineShell } from "./prepare-shell";

const api = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      methodOverride: "POST",
      fetch: (url, init) =>
        fetch(url, { ...init, cache: "no-store", credentials: "same-origin" }),
    }),
  ],
});
const control =
  "mt-1 block w-full rounded-md border border-input bg-background p-3 text-base";
const labels = {
  subjective: "History",
  objective: "Examination",
  assessment: "Assessment",
  plan: "Plan and instructions",
};
const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Unable to finish. Your saved device copy has been kept.";
function download(contents: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FieldApp() {
  const online = useOnlineStatus();
  const [connection, setConnection] = useState<ClinicConnection>("checking");
  const [connectionCheck, setConnectionCheck] = useState(0);
  const [target, setTarget] = useState(() =>
    fieldPreparationTarget(location.hash),
  );
  const [section, setSection] = useState<"notes" | "treatments" | "checkout">(
    "notes",
  );
  useEffect(() => {
    const update = () => setTarget(fieldPreparationTarget(location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    let active = true;
    if (!online) {
      setConnection("unreachable");
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    setConnection("checking");
    void api.offlineField.session
      .query(undefined, { signal: controller.signal })
      .then(
        () => {
          if (active) setConnection("connected");
        },
        (error) => {
          if (active)
            setConnection(
              error instanceof TRPCClientError &&
                error.data?.code === "UNAUTHORIZED"
                ? "signed-out"
                : error instanceof TRPCClientError &&
                    error.data?.code === "FORBIDDEN"
                  ? "access-denied"
                  : "unreachable",
            );
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [online, connectionCheck]);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible")
        setConnectionCheck((value) => value + 1);
    };
    const timer = setInterval(check, 30_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  const [workspace, setWorkspace] = useState<FieldWorkspace | null>(null);
  const current = useRef<FieldWorkspace | null>(null);
  const vault = useRef<EncryptedDeviceVault<FieldWorkspace> | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const failed = useRef(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const recovery = useRef<EncryptedVaultRecovery | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<
    Awaited<ReturnType<typeof api.offlineField.patients.query>>
  >([]);
  const [day, setDay] = useState(new Date().toLocaleDateString("en-CA"));
  const [visits, setVisits] = useState<
    Awaited<ReturnType<typeof api.offlineField.day.query>>
  >([]);
  const [serviceId, setServiceId] = useState("");
  const [restore, setRestore] = useState<EncryptedVaultRecovery | null>(null);
  const [onlineRecovery, setOnlineRecovery] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const entry =
    workspace?.entries.find((e) => e.packet.id === selected) ?? null;
  const expired = !!entry && clock >= Date.parse(entry.packet.expiresAt);
  const locked =
    busy || storageFailed || expired || !entry?.started || !!entry?.submission;
  const totals = entry ? fieldTotals(entry.packet, entry.draft) : null;

  useEffect(() => {
    void fieldWorkspaceExists()
      .then(setExists)
      .catch((e) => {
        setError(message(e));
        setExists(false);
      });
  }, []);
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 1000);
    const before = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || failed.current || recovery.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      clearInterval(id);
      window.removeEventListener("beforeunload", before);
    };
  }, []);
  useEffect(() => {
    if (!workspace || !dirty || failed.current) return;
    const timer = setTimeout(() => {
      void persist(workspace).catch((e) => setError(message(e)));
    }, 500);
    return () => clearTimeout(timer);
  }, [workspace, dirty]);
  useEffect(() => {
    if (!online) setOnlineRecovery(0);
  }, [online]);
  useEffect(() => {
    if (!workspace) return;
    const expiry = Math.max(
      ...workspace.entries.map((e) => Date.parse(e.packet.expiresAt)),
      0,
    );
    if (
      expiry &&
      clock >= expiry &&
      clock >= onlineRecovery &&
      !busyRef.current
    )
      void run(async () => {
        if (dirtyRef.current && !failed.current)
          await persist(current.current!);
        if (failed.current)
          recovery.current = await vault.current!.sealForRecovery(
            current.current!,
          );
        current.current = null;
        vault.current = null;
        setWorkspace(null);
        setNotice(
          "Offline access expired. Reconnect and sign in to recover and synchronize your work.",
        );
      });
  }, [clock, workspace, onlineRecovery]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function show(value: FieldWorkspace) {
    current.current = value;
    setWorkspace(value);
  }
  async function persist(value: FieldWorkspace) {
    try {
      await vault.current!.save(value);
      if (current.current === value) {
        dirtyRef.current = false;
        setDirty(false);
        setNotice("Encrypted device copy saved");
      }
    } catch (e) {
      failed.current = true;
      setStorageFailed(true);
      setNotice("");
      throw new Error(
        `Device storage failed. Keep this tab open and download an encrypted backup before continuing. ${message(e)}`,
      );
    }
  }
  async function commit(value: FieldWorkspace) {
    assertFieldWorkspaceCapacity(value);
    show(value);
    dirtyRef.current = true;
    setDirty(true);
    await persist(value);
  }
  function changeDraft(patch: Partial<FieldVisit>) {
    if (!entry || locked || !current.current) return;
    const next = {
      ...current.current,
      entries: current.current.entries.map((e) =>
        e.packet.id === entry.packet.id
          ? { ...e, draft: { ...e.draft, ...patch } }
          : e,
      ),
    };
    try {
      assertFieldWorkspaceCapacity(next);
    } catch (error) {
      setError(message(error));
      return;
    }
    show(next);
    dirtyRef.current = true;
    setDirty(true);
    setNotice("Saving encrypted device copy…");
  }
  async function unlock() {
    const secret = passphrase;
    setPassphrase("");
    setConfirmation("");
    let session: Awaited<
      ReturnType<typeof api.offlineField.session.query>
    > | null = null;
    if (online) {
      try {
        session = await api.offlineField.session.query();
      } catch (error) {
        // A network interface can be up with no route to the server. Authorization
        // denials still fail closed; only transport failures allow the device lease.
        if (!(error instanceof TRPCClientError) || error.data?.code)
          throw error;
      }
    }
    const opened = await openFieldWorkspace(
      secret,
      restore ?? recovery.current ?? undefined,
    );
    let value = opened.value;
    if (!value) {
      if (!session?.enabled)
        throw new Error(
          "Sign in to an enabled field pilot online before creating this workspace.",
        );
      value = {
        version: 1,
        userId: session.userId,
        practiceId: session.practiceId,
        entries: [],
      };
    }
    if (
      session &&
      (session.userId !== value.userId ||
        session.practiceId !== value.practiceId)
    )
      throw new Error("Sign in as the owner of this workspace.");
    if (
      !session &&
      (!value.entries.length ||
        value.entries.every(
          (e) =>
            Date.now() >= Date.parse(e.packet.expiresAt) ||
            Date.now() < Date.parse(e.packet.preparedAt),
        ))
    )
      throw new Error("Reconnect and sign in to recover expired offline work.");
    setOnlineRecovery(session ? Date.now() + 300_000 : 0);
    vault.current = opened.vault;
    failed.current = false;
    setStorageFailed(false);
    // Persist setup even before the first patient is prepared, so returning from
    // a chart or schedule link unlocks the same device workspace.
    if (!opened.value || restore || recovery.current)
      await opened.vault.save(value);
    recovery.current = null;
    setRestore(null);
    show(value);
    setExists(true);
    setSelected(value.entries[0]?.packet.id ?? null);
    setSection(value.entries[0]?.submission ? "checkout" : "notes");
    dirtyRef.current = false;
    setDirty(false);
    if (session) {
      await prepareOfflineShell();
      await navigator.storage?.persist?.();
    }
  }
  async function prepare(patientId: string, appointmentId?: string) {
    if (!current.current || dirtyRef.current || failed.current)
      throw new Error("Wait for your existing work to finish saving first.");
    if (current.current.entries.length >= 20)
      throw new Error(
        "Remove a synchronized visit before preparing more than 20.",
      );
    if (
      current.current.entries.some(
        (e) =>
          !e.result &&
          (appointmentId
            ? e.packet.appointment?.id === appointmentId
            : e.packet.patientId === patientId),
      )
    )
      throw new Error(
        "This patient already has a prepared visit on this device.",
      );
    await prepareOfflineShell();
    const packet = await api.offlineField.prepare.mutate({
      patientId,
      appointmentId,
    });
    await commit({
      ...current.current,
      entries: [...current.current.entries, newFieldEntry(packet)],
    });
    setSelected(packet.id);
    setSection("notes");
    setServiceId("");
  }
  async function seal() {
    if (!entry || !current.current) return;
    if (dirtyRef.current) await persist(current.current);
    const submission = {
      packet: entry.packet,
      visit: { ...entry.draft, issuedAt: new Date().toISOString() },
    };
    validateFieldSubmission(submission);
    await commit({
      ...current.current!,
      entries: current.current!.entries.map((e) =>
        e.packet.id === entry.packet.id ? { ...e, submission } : e,
      ),
    });
    setNotice(
      "Receipt saved on this device. You can print it now and synchronize after reconnecting.",
    );
  }
  async function sync(item: FieldEntry) {
    if (!item.submission || !current.current || failed.current)
      throw new Error("Save and issue this visit before synchronizing.");
    const session = await api.offlineField.session.query();
    if (
      session.userId !== current.current.userId ||
      session.practiceId !== current.current.practiceId
    )
      throw new Error("Sign in as the workspace owner.");
    const result = await api.offlineField.sync.mutate(item.submission);
    await commit({
      ...current.current,
      entries: current.current.entries.map((e) =>
        e.packet.id === item.packet.id ? { ...e, result } : e,
      ),
    });
    setNotice(
      "Visit synchronized. Review and sign the note online. The original receipt is unchanged.",
    );
  }
  async function backup() {
    const sealed =
      current.current && vault.current
        ? await vault.current.sealForRecovery(current.current)
        : recovery.current;
    if (!sealed)
      throw new Error("Unlock your workspace before downloading a backup.");
    download(
      serializeFieldBackup(sealed),
      `openvpm-field-backup-${new Date().toISOString().slice(0, 10)}.json`,
    );
    setNotice(
      "Encrypted backup downloaded. Keep it with your passphrase stored separately; restore it only in an empty field workspace.",
    );
  }
  const canEdit = entry && !locked;
  return (
    <FieldShell
      online={online}
      connection={connection}
      checkConnection={() => setConnectionCheck((value) => value + 1)}
      busy={busy}
    >
      <main
        id="field-main"
        tabIndex={-1}
        className="mx-auto max-w-6xl p-4 outline-none sm:p-6"
      >
        <style>{`@media print { body > *:not(#field-receipt) { display:none!important } #field-receipt { display:block!important;padding:12px;font-size:12px } #field-receipt p { overflow-wrap:anywhere } }`}</style>
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-primary">
              Mobile care
            </p>
            <h2 className="mt-1 font-heading text-2xl font-semibold">
              Your field day
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Prepare while connected. Record care offline. Synchronize when you
              return.
            </p>
          </div>
          {workspace && (
            <div
              className="flex flex-wrap gap-3 text-sm"
              aria-label="Field day status"
            >
              <div className="rounded-lg border bg-background px-4 py-2">
                <strong>
                  {workspace.entries.filter((e) => !e.started).length}
                </strong>{" "}
                ready
              </div>
              <div className="rounded-lg border bg-background px-4 py-2">
                <strong>
                  {
                    workspace.entries.filter((e) => e.started && !e.submission)
                      .length
                  }
                </strong>{" "}
                in progress
              </div>
              <div className="rounded-lg border bg-background px-4 py-2">
                <strong>
                  {
                    workspace.entries.filter((e) => e.submission && !e.result)
                      .length
                  }
                </strong>{" "}
                awaiting sync
              </div>
            </div>
          )}
        </div>
        {workspace && (
          <div
            className="mb-4 flex flex-wrap justify-between gap-2 rounded-lg border bg-background px-4 py-3 text-sm"
            aria-label="Device save status"
          >
            <span>
              {storageFailed
                ? "Device save failed — keep this tab open"
                : dirty
                  ? "Saving to this device…"
                  : "Saved on this device · encrypted"}
            </span>
            <span className="text-muted-foreground">
              {entry?.result
                ? "Selected visit synced to clinic"
                : "Device saves are not yet clinic records"}
            </span>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4 text-red-900"
          >
            {error}
          </div>
        )}
        {notice && (
          <p
            role="status"
            className={
              notice === "Encrypted device copy saved"
                ? "sr-only"
                : "mb-4 rounded-lg border p-3"
            }
          >
            {notice}
          </p>
        )}
        {recovery.current && (
          <p className="mb-4 text-red-800">
            The newest recovery copy exists only in this tab. Keep it open or
            download an encrypted backup.
            <Button onClick={() => void run(backup)}>
              Download recovery backup
            </Button>
          </p>
        )}
        {!workspace ? (
          <section className="mx-auto max-w-xl rounded-xl border bg-background p-6 sm:p-8">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-primary">
              {exists ? "Welcome back" : "One-time device setup"}
            </p>
            <h2 className="text-xl font-semibold">
              {exists ? "Unlock field workspace" : "Prepare a trusted device"}
            </h2>
            <p className="my-3 text-sm">
              Prepare patients before leaving internet access. Use the same
              device and browser for the day. Your passphrase encrypts the
              device copy and cannot be reset. Offline access lasts 24 hours
              after preparation.
            </p>
            {!exists && (
              <p className="mb-4 rounded-md bg-surface p-3 text-sm">
                Choose at least 12 characters. Keep the passphrase somewhere
                safe; OpenVPM cannot reset it. Next time, you only need to
                unlock this device.
              </p>
            )}
            {target && (
              <p className="mb-4 text-sm text-primary">
                Your selected {target.appointmentId ? "appointment" : "patient"}{" "}
                is ready to prepare after you unlock.
              </p>
            )}
            <label>
              Field passphrase
              <input
                className={control}
                type="password"
                autoComplete="off"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
            {!exists && !restore && (
              <label className="mt-3 block">
                Confirm field passphrase
                <input
                  className={control}
                  type="password"
                  autoComplete="off"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
            )}
            <Button
              className="mt-4"
              disabled={
                busy ||
                exists === null ||
                passphrase.length < 12 ||
                (!exists && !restore && passphrase !== confirmation)
              }
              onClick={() => void run(unlock)}
            >
              {exists || restore
                ? "Unlock field workspace"
                : "Create field workspace"}
            </Button>
            {!exists && (
              <details className="mt-5">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Restore a saved backup
                </summary>
                <label className="mt-5 block text-sm">
                  Restore an encrypted field backup
                  <input
                    className={control}
                    type="file"
                    accept="application/json,.json"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f)
                        void run(async () => {
                          if (f.size > 11_000_000)
                            throw new Error("Backup is too large.");
                          setRestore(parseFieldBackup(await f.text()));
                          setNotice(
                            "Enter the backup's original passphrase to restore it.",
                          );
                        });
                    }}
                  />
                </label>
              </details>
            )}
            <a
              className="mt-5 block text-teal-700 underline"
              href="/login"
              target="_blank"
              rel="noreferrer"
            >
              Sign in online
            </a>
          </section>
        ) : (
          <>
            <div className="mb-4 grid items-start gap-3 lg:grid-cols-2">
              <details className="rounded-lg border bg-background px-4 py-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Device &amp; recovery
                </summary>
                <p className="mt-3 text-sm text-muted-foreground">
                  Download a backup before leaving and after important work.
                  Keep your passphrase separately.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(backup)}
                  >
                    Download encrypted backup
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || dirty || storageFailed}
                    onClick={() => {
                      current.current = null;
                      vault.current = null;
                      setWorkspace(null);
                    }}
                  >
                    Lock workspace
                  </Button>
                  <a
                    className="self-center px-2 text-sm underline"
                    href="/offline/index.html"
                  >
                    Offline chart notes
                  </a>
                </div>
              </details>
              {target && (
                <section
                  className="rounded-xl border border-primary/30 bg-background p-4 lg:col-span-2 lg:order-first"
                  aria-label="Selected field preparation"
                >
                  <h3 className="font-semibold">
                    Prepare selected{" "}
                    {target.appointmentId ? "appointment" : "patient"}
                  </h3>
                  <p className="my-2 text-sm text-muted-foreground">
                    Save this chart and service prices on this device for a
                    field visit. Nothing is prepared until you select the button
                    below.
                  </p>
                  <Button
                    disabled={!online || busy || dirty || storageFailed}
                    onClick={() =>
                      void run(async () => {
                        const existing = current.current?.entries.find(
                          (e) =>
                            !e.result &&
                            (target.appointmentId
                              ? e.packet.appointment?.id ===
                                target.appointmentId
                              : e.packet.patientId === target.patientId),
                        );
                        if (existing) {
                          setSelected(existing.packet.id);
                          setSection(
                            existing.submission ? "checkout" : "notes",
                          );
                        } else
                          await prepare(target.patientId, target.appointmentId);
                        history.replaceState(null, "", location.pathname);
                        setTarget(null);
                      })
                    }
                  >
                    Prepare selected{" "}
                    {target.appointmentId ? "appointment" : "patient"}
                  </Button>
                </section>
              )}
              <details
                className={`rounded-lg border bg-background px-4 py-3 ${!workspace.entries.length ? "lg:col-span-2" : ""}`}
                open={!workspace.entries.length}
              >
                <summary className="cursor-pointer font-semibold">
                  Prepare visits while connected
                </summary>
                <p className="my-3 text-sm">
                  Preparation saves a dated snapshot. Select each patient or
                  appointment you need before leaving. Start the visit in the
                  field.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex-1">
                    Patient or owner surname
                    <input
                      className={control}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <Button
                    disabled={!online || busy}
                    onClick={() =>
                      void run(async () =>
                        setMatches(
                          await api.offlineField.patients.query({ query }),
                        ),
                      )
                    }
                  >
                    Find patients
                  </Button>
                </div>
                <ul className="my-3 space-y-2">
                  {matches.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-3 border-b py-2"
                    >
                      <span>
                        {p.name} · {p.clientName}
                      </span>
                      <Button
                        variant="outline"
                        disabled={busy || !online || dirty || storageFailed}
                        onClick={() => void run(() => prepare(p.id))}
                      >
                        Prepare {p.name}
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-end gap-2">
                  <label>
                    Appointments on this device's date
                    <input
                      className={control}
                      type="date"
                      value={day}
                      onChange={(e) => setDay(e.target.value)}
                    />
                  </label>
                  <Button
                    variant="outline"
                    disabled={!online || busy || !day}
                    onClick={() =>
                      void run(async () => {
                        const start = new Date(`${day}T00:00:00`);
                        const end = new Date(start);
                        end.setDate(end.getDate() + 1);
                        setVisits(
                          await api.offlineField.day.query({
                            start: start.toISOString(),
                            end: end.toISOString(),
                          }),
                        );
                      })
                    }
                  >
                    Find my appointments
                  </Button>
                </div>
                <ul>
                  {visits.map((v) => (
                    <li
                      key={v.id}
                      className="flex items-center justify-between border-b py-2"
                    >
                      <span>
                        {v.name} · {new Date(v.time).toLocaleTimeString()}
                      </span>
                      <Button
                        variant="outline"
                        disabled={busy || dirty || storageFailed}
                        onClick={() =>
                          void run(() => prepare(v.patientId, v.id))
                        }
                      >
                        Prepare appointment
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
            <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
              <nav aria-label="Prepared visits" className="space-y-2">
                <h3 className="mb-3 text-sm font-semibold">
                  Patients on this device
                </h3>
                {!workspace.entries.length && (
                  <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    No patients prepared yet. Use the preparation panel above
                    while connected.
                  </p>
                )}
                {workspace.entries.map((e) => (
                  <button
                    key={e.packet.id}
                    className={`w-full rounded-lg border p-3 text-left ${selected === e.packet.id ? "border-primary bg-primary/10" : "bg-background"}`}
                    disabled={busy || dirty || storageFailed}
                    onClick={() => {
                      setSelected(e.packet.id);
                      setSection(e.submission ? "checkout" : "notes");
                      setServiceId("");
                      setError(null);
                    }}
                  >
                    <strong className="block">{e.packet.patient.name}</strong>
                    <span className="text-sm text-muted-foreground">
                      {e.result
                        ? "Synchronized"
                        : e.submission
                          ? "Receipt saved · awaiting sync"
                          : e.started
                            ? "Visit in progress"
                            : "Ready to start"}
                    </span>
                  </button>
                ))}
              </nav>
              {entry ? (
                <article className="min-w-0 space-y-4">
                  <section className="rounded-xl border bg-background p-4 sm:p-5">
                    <h2 className="font-heading text-xl font-semibold">
                      {entry.packet.patient.name}
                    </h2>
                    <p>
                      {entry.packet.patient.species} ·{" "}
                      {entry.packet.patient.breed ?? "Breed not recorded"}
                    </p>
                    <p className="mt-2">
                      {entry.packet.client.name} ·{" "}
                      {entry.packet.client.phone ?? "No phone recorded"}
                    </p>
                    <p>{entry.packet.client.address}</p>
                    <p className="mt-3 text-sm text-muted-foreground">
                      Prepared{" "}
                      {new Date(entry.packet.preparedAt).toLocaleString()} ·
                      Offline until{" "}
                      {new Date(entry.packet.expiresAt).toLocaleString()}
                    </p>
                    <div className="mt-4 rounded-lg bg-amber-50 p-3">
                      <strong>Recorded allergies</strong>
                      {entry.packet.allergies.length ? (
                        <ul>
                          {entry.packet.allergies.map((a, i) => (
                            <li key={i}>
                              {a.allergen} · {a.severity} · {a.reaction}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>No allergies recorded in this snapshot.</p>
                      )}
                    </div>
                    <details className="mt-4">
                      <summary className="cursor-pointer font-medium">
                        Medication, vaccination and chart history
                      </summary>
                      <h3 className="mt-3 font-semibold">
                        Medications recorded active at preparation
                      </h3>
                      <ul>
                        {entry.packet.medications.map((m, i) => (
                          <li key={i}>
                            {m.name} · {m.dosage} · {m.frequency} —{" "}
                            {m.instructions}
                          </li>
                        ))}
                      </ul>
                      <h3 className="mt-3 font-semibold">
                        Latest recorded vaccinations
                      </h3>
                      <ul>
                        {entry.packet.vaccinations.map((v, i) => (
                          <li key={i}>
                            {v.name} ·{" "}
                            {new Date(v.administeredAt).toLocaleDateString()} ·
                            Due {v.nextDueDate ?? "not recorded"}
                          </li>
                        ))}
                      </ul>
                      <h3 className="mt-3 font-semibold">
                        Latest finalized visit notes
                      </h3>
                      {entry.packet.history.map((n, i) => (
                        <div key={i} className="my-3">
                          <p>{new Date(n.at).toLocaleDateString()}</p>
                          {Object.entries(n.sections).map(([key, text]) => (
                            <p key={key} className="whitespace-pre-wrap">
                              <strong>{key}: </strong>
                              {text.replace(/<[^>]*>/g, " ")}
                            </p>
                          ))}
                        </div>
                      ))}
                      <h3 className="mt-3 font-semibold">Latest chart notes</h3>
                      {entry.packet.notes.map((n, i) => (
                        <p key={i} className="my-2 whitespace-pre-wrap">
                          {n.content}
                        </p>
                      ))}
                    </details>
                    {!entry.started && (
                      <Button
                        className="mt-4"
                        disabled={busy || expired || storageFailed}
                        onClick={() =>
                          void run(async () => {
                            await commit({
                              ...current.current!,
                              entries: current.current!.entries.map((e) =>
                                e.packet.id === entry.packet.id
                                  ? {
                                      ...e,
                                      started: true,
                                      draft: {
                                        ...e.draft,
                                        startedAt: new Date().toISOString(),
                                      },
                                    }
                                  : e,
                              ),
                            });
                          })
                        }
                      >
                        Start field visit
                      </Button>
                    )}
                    {expired && (
                      <p className="mt-3 text-amber-900">
                        Offline preparation expired. Existing issued receipts
                        can still be synchronized after signing in online.
                      </p>
                    )}
                  </section>
                  {entry.started && (
                    <nav
                      className="sticky top-0 z-10 flex flex-wrap gap-2 rounded-xl border bg-background p-2 shadow-sm"
                      aria-label="Visit sections"
                    >
                      {(
                        [
                          ["notes", "1. Notes"],
                          ["treatments", "2. Treatments"],
                          ["checkout", "3. Checkout"],
                        ] as const
                      ).map(([key, label]) => (
                        <Button
                          key={key}
                          variant={section === key ? "default" : "ghost"}
                          aria-pressed={section === key}
                          onClick={() => setSection(key)}
                        >
                          {label}
                        </Button>
                      ))}
                    </nav>
                  )}
                  <section
                    hidden={!entry.started || section !== "notes"}
                    aria-label="Visit note"
                    className="rounded-xl border bg-background p-4 sm:p-5"
                  >
                    <h2 className="text-xl font-semibold">Visit note</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Notes save on this device. Review and sign online after
                      synchronization.
                    </p>
                    {Object.entries(labels).map(([key, label]) => (
                      <label key={key} className="mt-3 block">
                        {label}
                        <textarea
                          className={control}
                          rows={3}
                          maxLength={10000}
                          disabled={locked}
                          value={
                            entry.draft.sections[key as keyof typeof labels]
                          }
                          onChange={(e) =>
                            changeDraft({
                              sections: {
                                ...entry.draft.sections,
                                [key]: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                    <Button
                      className="mt-4"
                      variant="outline"
                      onClick={() => setSection("treatments")}
                    >
                      Continue to treatments
                    </Button>
                  </section>
                  <section
                    hidden={!entry.started || section !== "treatments"}
                    aria-label="Services and charges"
                    className="rounded-xl border bg-background p-4 sm:p-5"
                  >
                    <h2 className="text-xl font-semibold">
                      Services and charges
                    </h2>
                    <div className="my-3 flex items-end gap-2">
                      <label className="flex-1">
                        Prepared service
                        <select
                          className={control}
                          disabled={locked}
                          value={serviceId}
                          onChange={(e) => setServiceId(e.target.value)}
                        >
                          <option value="">Choose a service</option>
                          {entry.packet.services
                            .filter(
                              (s) =>
                                !entry.draft.charges.some(
                                  (c) => c.serviceId === s.id,
                                ),
                            )
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name} · ${s.price}
                              </option>
                            ))}
                        </select>
                      </label>
                      <Button
                        disabled={locked || !serviceId}
                        onClick={() => {
                          changeDraft({
                            charges: [
                              ...entry.draft.charges,
                              { serviceId, quantity: 1 },
                            ],
                          });
                          setServiceId("");
                        }}
                      >
                        Add charge
                      </Button>
                    </div>
                    {totals?.lines.map((line) => (
                      <div
                        key={line.id}
                        className="flex items-end gap-3 border-b py-2"
                      >
                        <span className="flex-1">
                          {line.name} · {dollars(line.lineTotalCents)}
                        </span>
                        <label className="w-24">
                          Quantity
                          <input
                            className={control}
                            aria-label={`Quantity for ${line.name}`}
                            type="number"
                            min="1"
                            max="100"
                            disabled={locked}
                            value={line.quantity}
                            onChange={(e) => {
                              const q = Number(e.target.value);
                              if (Number.isInteger(q) && q >= 1 && q <= 100)
                                changeDraft({
                                  charges: entry.draft.charges.map((c) =>
                                    c.serviceId === line.id
                                      ? { ...c, quantity: q }
                                      : c,
                                  ),
                                });
                            }}
                          />
                        </label>
                        <Button
                          variant="outline"
                          disabled={
                            locked ||
                            entry.draft.vaccinations.some(
                              (v) => v.serviceId === line.id,
                            )
                          }
                          onClick={() =>
                            changeDraft({
                              charges: entry.draft.charges.filter(
                                (c) => c.serviceId !== line.id,
                              ),
                            })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <p className="mt-4">
                      Subtotal {dollars(totals?.subtotalCents ?? 0)} · Tax{" "}
                      {dollars(totals?.taxCents ?? 0)} ·{" "}
                      <strong>Total {dollars(totals?.totalCents ?? 0)}</strong>
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Service charges only. Product stock and medication
                      dispensing remain online.
                    </p>
                  </section>
                  <section
                    hidden={!entry.started || section !== "treatments"}
                    aria-label="Vaccinations given"
                    className="rounded-xl border bg-background p-4 sm:p-5"
                  >
                    <h2 className="text-xl font-semibold">
                      Vaccinations given
                    </h2>
                    <p className="my-2 text-sm">
                      Each vaccination must match a charge. Administration time
                      is preserved when synchronized.
                    </p>
                    {entry.draft.vaccinations.map((v, i) => (
                      <fieldset
                        key={v.id}
                        disabled={locked}
                        className="my-4 rounded-lg border p-4"
                      >
                        <legend>Vaccination {i + 1}</legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {(
                            [
                              ["vaccineName", "Vaccine"],
                              ["productName", "Product"],
                              ["manufacturer", "Manufacturer"],
                              ["lotNumber", "Lot number"],
                              ["rabiesTagNumber", "Rabies tag"],
                            ] as const
                          ).map(([key, label]) => (
                            <label key={key}>
                              {label}
                              <input
                                className={control}
                                value={v[key]}
                                maxLength={
                                  key === "lotNumber" ||
                                  key === "rabiesTagNumber"
                                    ? 64
                                    : key === "manufacturer"
                                      ? 128
                                      : 255
                                }
                                onChange={(e) =>
                                  changeDraft({
                                    vaccinations: entry.draft.vaccinations.map(
                                      (x) =>
                                        x.id === v.id
                                          ? { ...x, [key]: e.target.value }
                                          : x,
                                    ),
                                  })
                                }
                              />
                            </label>
                          ))}
                          <label>
                            Service charge
                            <select
                              className={control}
                              value={v.serviceId}
                              onChange={(e) =>
                                changeDraft({
                                  vaccinations: entry.draft.vaccinations.map(
                                    (x) =>
                                      x.id === v.id
                                        ? { ...x, serviceId: e.target.value }
                                        : x,
                                  ),
                                })
                              }
                            >
                              {totals?.lines
                                .filter(
                                  (l) =>
                                    l.id === v.serviceId ||
                                    !entry.draft.vaccinations.some(
                                      (x) => x.serviceId === l.id,
                                    ),
                                )
                                .map((l) => (
                                  <option key={l.id} value={l.id}>
                                    {l.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                          {(
                            [
                              ["productExpirationDate", "Product expiration"],
                              ["nextDueDate", "Next due date"],
                            ] as const
                          ).map(([key, label]) => (
                            <label key={key}>
                              {label}
                              <input
                                type="date"
                                className={control}
                                value={v[key] ?? ""}
                                onChange={(e) =>
                                  changeDraft({
                                    vaccinations: entry.draft.vaccinations.map(
                                      (x) =>
                                        x.id === v.id
                                          ? {
                                              ...x,
                                              [key]: e.target.value || null,
                                            }
                                          : x,
                                    ),
                                  })
                                }
                              />
                            </label>
                          ))}
                          <label>
                            Dose type
                            <select
                              className={control}
                              value={v.doseType}
                              onChange={(e) =>
                                changeDraft({
                                  vaccinations: entry.draft.vaccinations.map(
                                    (x) =>
                                      x.id === v.id
                                        ? {
                                            ...x,
                                            doseType: e.target.value as
                                              | "initial"
                                              | "booster",
                                          }
                                        : x,
                                  ),
                                })
                              }
                            >
                              <option value="initial">Initial</option>
                              <option value="booster">Booster</option>
                            </select>
                          </label>
                        </div>
                        <p className="my-2 text-sm">
                          Recorded at{" "}
                          {new Date(v.administeredAt).toLocaleString()}
                        </p>
                        <Button
                          variant="outline"
                          onClick={() =>
                            changeDraft({
                              vaccinations: entry.draft.vaccinations.filter(
                                (x) => x.id !== v.id,
                              ),
                            })
                          }
                        >
                          Remove vaccination
                        </Button>
                      </fieldset>
                    ))}
                    <Button
                      variant="outline"
                      disabled={
                        !canEdit ||
                        entry.draft.vaccinations.length >= 30 ||
                        !totals?.lines.some(
                          (l) =>
                            !entry.draft.vaccinations.some(
                              (v) => v.serviceId === l.id,
                            ),
                        )
                      }
                      onClick={() => {
                        const s = totals!.lines.find(
                          (l) =>
                            !entry.draft.vaccinations.some(
                              (v) => v.serviceId === l.id,
                            ),
                        )!;
                        changeDraft({
                          vaccinations: [
                            ...entry.draft.vaccinations,
                            {
                              id: crypto.randomUUID(),
                              vaccineName: s.name,
                              productName: "",
                              manufacturer: "",
                              lotNumber: "",
                              productExpirationDate: null,
                              administeredAt: new Date().toISOString(),
                              nextDueDate: null,
                              doseType: "initial",
                              rabiesTagNumber: "",
                              serviceId: s.id,
                            },
                          ],
                        });
                      }}
                    >
                      Add vaccination
                    </Button>
                    <Button
                      className="ml-2 mt-4"
                      variant="outline"
                      onClick={() => setSection("checkout")}
                    >
                      Continue to checkout
                    </Button>
                  </section>
                  <section
                    hidden={!entry.started || section !== "checkout"}
                    aria-label="Payment and receipt"
                    className="rounded-xl border bg-background p-4 sm:p-5"
                  >
                    <h2 className="text-xl font-semibold">
                      Payment and receipt
                    </h2>
                    {!entry.submission && (
                      <>
                        <label className="my-3 block">
                          Payment received
                          <select
                            className={control}
                            disabled={locked}
                            value={entry.draft.payment?.method ?? "none"}
                            onChange={(e) =>
                              changeDraft({
                                payment:
                                  e.target.value === "none"
                                    ? null
                                    : {
                                        method: e.target.value as
                                          | "cash"
                                          | "check",
                                        amount: (
                                          (totals?.totalCents ?? 0) / 100
                                        ).toFixed(2),
                                        receivedAt: new Date().toISOString(),
                                        reference: "",
                                      },
                              })
                            }
                          >
                            <option value="none">
                              No payment — itemized bill
                            </option>
                            <option value="cash">Cash</option>
                            <option value="check">Check</option>
                          </select>
                        </label>
                        {entry.draft.payment && (
                          <>
                            <label>
                              Amount received
                              <input
                                className={control}
                                disabled={locked}
                                inputMode="decimal"
                                defaultValue={entry.draft.payment.amount}
                                key={`${entry.packet.id}:${entry.draft.payment.method}`}
                                onBlur={(e) => {
                                  const n = Number(e.target.value);
                                  if (
                                    Number.isFinite(n) &&
                                    n > 0 &&
                                    Math.round(n * 100) <=
                                      (totals?.totalCents ?? 0)
                                  ) {
                                    changeDraft({
                                      payment: {
                                        ...entry.draft.payment!,
                                        amount: n.toFixed(2),
                                      },
                                    });
                                  } else {
                                    e.target.value =
                                      entry.draft.payment!.amount;
                                    setError(
                                      "Enter a positive payment no greater than the visit total.",
                                    );
                                  }
                                }}
                              />
                            </label>
                            <label className="mt-3 block">
                              Check/reference (optional)
                              <input
                                className={control}
                                disabled={locked}
                                maxLength={100}
                                value={entry.draft.payment.reference}
                                onChange={(e) =>
                                  changeDraft({
                                    payment: {
                                      ...entry.draft.payment!,
                                      reference: e.target.value,
                                    },
                                  })
                                }
                              />
                            </label>
                          </>
                        )}
                      </>
                    )}
                    <div className="my-4 rounded-lg bg-surface p-4 text-sm">
                      <h3 className="mb-2 font-semibold">Review this visit</h3>
                      {totals?.lines.map((line) => (
                        <p key={line.id} className="flex justify-between gap-4">
                          <span>
                            {line.name} × {line.quantity}
                          </span>
                          <span>{dollars(line.lineTotalCents)}</span>
                        </p>
                      ))}
                      <p className="mt-2 flex justify-between border-t pt-2">
                        <span>Tax</span>
                        <span>{dollars(totals?.taxCents ?? 0)}</span>
                      </p>
                      <p className="flex justify-between font-semibold">
                        <span>Total</span>
                        <span>{dollars(totals?.totalCents ?? 0)}</span>
                      </p>
                      {entry.submission && (
                        <p className="mt-3">
                          {entry.draft.payment
                            ? `Received ${dollars(Math.round(Number(entry.draft.payment.amount) * 100))} by ${entry.draft.payment.method}${entry.draft.payment.reference ? ` · ${entry.draft.payment.reference}` : ""}`
                            : "No payment received"}
                        </p>
                      )}
                      <p className="mt-3 text-muted-foreground">
                        {entry.draft.vaccinations.length} vaccination records ·{" "}
                        {entry.result
                          ? "Synced to clinic"
                          : entry.submission
                            ? "Receipt issued · awaiting sync"
                            : "Not yet issued"}
                      </p>
                    </div>
                    <p className="my-3">
                      Balance for this visit:{" "}
                      <strong>{dollars(totals?.balanceCents ?? 0)}</strong>.
                      Prior account balances are not included.
                    </p>
                    {!entry.submission ? (
                      <>
                        <p className="my-3 text-sm">
                          Review the details before issuing. Issuing saves an
                          immutable bill/receipt on this device; corrections
                          need online reconciliation. Clinical signing remains
                          online.
                        </p>
                        <Button
                          disabled={
                            locked || dirty || !entry.draft.charges.length
                          }
                          onClick={() => void run(seal)}
                        >
                          Issue field receipt
                        </Button>
                      </>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={busy || dirty || storageFailed}
                          onClick={() => window.print()}
                        >
                          Print receipt / Save PDF
                        </Button>
                        {!entry.result && (
                          <Button
                            disabled={!online || busy || dirty || storageFailed}
                            onClick={() => void run(() => sync(entry))}
                          >
                            Synchronize visit
                          </Button>
                        )}
                        {entry.result && (
                          <a
                            className="rounded-md border p-2 underline"
                            href={`/encounters/${entry.result.appointmentId}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Review and sign online
                          </a>
                        )}
                      </div>
                    )}
                    {entry.result && (
                      <Button
                        className="mt-3"
                        variant="outline"
                        disabled={busy || dirty}
                        onClick={() =>
                          void run(async () => {
                            await commit({
                              ...current.current!,
                              entries: current.current!.entries.filter(
                                (e) => e.packet.id !== entry.packet.id,
                              ),
                            });
                            setSelected(null);
                          })
                        }
                      >
                        Remove synchronized device copy
                      </Button>
                    )}
                  </section>
                  {entry.submission &&
                    createPortal(<FieldReceipt entry={entry} />, document.body)}
                </article>
              ) : (
                <p className="p-5">Prepare or select a visit to begin.</p>
              )}
            </div>
          </>
        )}
      </main>
    </FieldShell>
  );
}

function FieldReceipt({ entry }: { entry: FieldEntry }) {
  const { packet, visit } = entry.submission!;
  const total = validateFieldSubmission(entry.submission!);
  return (
    <section id="field-receipt" className="hidden">
      <h1 className="text-2xl font-bold">{packet.practice.name}</h1>
      <p>
        {[packet.practice.address, packet.practice.phone]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <h2 className="my-4 text-xl">
        {visit.payment ? "Payment receipt" : "Itemized bill"}
      </h2>
      <p>Field reference: {packet.id}</p>
      <p>
        Issued:{" "}
        {new Date(visit.issuedAt).toLocaleString("en-US", {
          timeZone: packet.practice.timezone,
        })}{" "}
        ({packet.practice.timezone})
      </p>
      <p>
        {packet.client.name} · Patient: {packet.patient.name}
      </p>
      <table className="my-5 w-full text-left">
        <thead>
          <tr>
            <th>Service</th>
            <th>Quantity</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {total.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td>{l.quantity}</td>
              <td>{dollars(l.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Subtotal {dollars(total.subtotalCents)}</p>
      <p>Tax {dollars(total.taxCents)}</p>
      <p>Total {dollars(total.totalCents)}</p>
      <p>
        Received {dollars(total.paidCents)}{" "}
        {visit.payment ? `by ${visit.payment.method}` : ""}
      </p>
      <p>Remaining for this visit {dollars(total.balanceCents)}</p>
      <p className="mt-5 text-sm">
        Recorded in the field. Clinic synchronization was pending when issued.
        This reference identifies the same receipt after synchronization. Prior
        account balances are excluded.
      </p>
    </section>
  );
}
