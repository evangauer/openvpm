import { TOOL_PATHS } from "./navigation";
import { parseSidebarPreferences, serializeSidebarPreferences, type SidebarPreferences, type SidebarLayout } from "./sidebar-pins";

export type SidebarEdit = { kind: "layout"; layout: SidebarLayout } | { kind: "pin"; href: string; pinned: boolean };
export type SidebarCommand = SidebarEdit | { kind: "import"; preferences: SidebarPreferences };
type PendingEdit = { id: string; edit: SidebarEdit };
type PendingStore = {
  read: () => PendingEdit[];
  put: (entry: PendingEdit) => Promise<void>;
  remove: (entry: PendingEdit) => Promise<void>;
};
const empty = () => ({ layout: "full", pinned: [] }) as SidebarPreferences;
export const EMPTY_SIDEBAR = serializeSidebarPreferences(empty());
function apply(value: SidebarPreferences, edit: SidebarEdit): SidebarPreferences {
  if (edit.kind === "layout") return { ...value, layout: edit.layout };
  return { ...value, pinned: [...value.pinned.filter(href => href !== edit.href), ...(edit.pinned ? [edit.href] : [])] };
}
function validEdit(value: unknown): value is SidebarEdit {
  if (!value || typeof value !== "object") return false;
  const e = value as SidebarEdit;
  return (e.kind === "layout" && ["full", "focused"].includes(e.layout)) ||
    (e.kind === "pin" && TOOL_PATHS.includes(e.href) && typeof e.pinned === "boolean");
}

const target = (edit: SidebarEdit) => edit.kind === "layout" ? "layout" : edit.href;

/** Each choice has its own outbox entry, so another tab's refresh cannot erase it. */
export function sidebarPendingStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  cacheKey: string,
  withLock: (work: () => void) => Promise<void>,
): PendingStore {
  const key = (choice: string) => `${cacheKey}.pending.${encodeURIComponent(choice)}`;
  const read = (choice: string): PendingEdit | null => {
    const raw = storage.getItem(key(choice));
    if (!raw || raw.length > 1024) return null;
    try {
      const entry = JSON.parse(raw);
      return typeof entry.id === "string" && entry.id.length === 36 && validEdit(entry.edit) && target(entry.edit) === choice ? entry : null;
    } catch { return null; }
  };
  return {
    read: () => ["layout", ...TOOL_PATHS].flatMap(choice => { const entry = read(choice); return entry ? [entry] : []; }),
    put: entry => withLock(() => storage.setItem(key(target(entry.edit)), JSON.stringify(entry))),
    remove: entry => withLock(() => {
      // A newer choice may have replaced this one while the server was saving it.
      if (read(target(entry.edit))?.id === entry.id) storage.removeItem(key(target(entry.edit)));
    }),
  };
}

/** One identity's cache and retry queue. Legacy v1 storage is never overwritten. */
export class SidebarSync {
  private base = empty();
  private pending: PendingEdit[] = [];
  private unsaved = new Set<string>();
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private raw = EMPTY_SIDEBAR;
  constructor(private io: {
    legacy: string | null;
    cached: string | null;
    read: () => Promise<SidebarPreferences | null>;
    write: (command: SidebarCommand) => Promise<SidebarPreferences>;
    save: (raw: string) => void;
    pending: PendingStore;
    error: () => void;
    storageError?: () => void;
    isRejected?: (error: unknown) => boolean;
    rejected?: () => void;
  }) {
    this.base = parseSidebarPreferences(io.legacy);
    try {
      if (io.cached && io.cached.length <= 65536) {
        const cached = JSON.parse(io.cached);
        if (cached.version === 2) {
          this.base = parseSidebarPreferences(JSON.stringify(cached.preferences));
        }
      }
    } catch { /* Keep original browser preference on malformed cache. */ }
    // Rendering only reads storage; edit/flush are responsible for writes.
    this.refreshPending(false);
    this.publish(false);
  }
  snapshot = () => this.raw;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(save = true) {
    const current = this.pending.reduce((value, entry) => apply(value, entry.edit), this.base);
    this.raw = serializeSidebarPreferences(current);
    if (save) {
      try { this.io.save(JSON.stringify({ version: 2, preferences: JSON.parse(serializeSidebarPreferences(this.base)) })); }
      catch { (this.io.storageError ?? this.io.error)(); }
    }
    this.listeners.forEach(listener => listener());
  }
  private refreshPending(reportError = true) {
    try {
      const retained = this.pending.filter(entry => this.unsaved.has(entry.id));
      const targets = new Set(retained.map(entry => target(entry.edit)));
      this.pending = [...this.io.pending.read().filter(entry => !targets.has(target(entry.edit))), ...retained];
    } catch { if (reportError) (this.io.storageError ?? this.io.error)(); }
  }
  private async acknowledge(entry: PendingEdit) {
    // A blocked browser store still allows the in-memory choice to reach the account.
    if (!this.unsaved.has(entry.id)) await this.io.pending.remove(entry);
    this.unsaved.delete(entry.id);
    this.pending = this.pending.filter(item => item.id !== entry.id);
    this.refreshPending();
  }
  edit(edit: SidebarEdit) {
    if (!validEdit(edit)) return;
    this.refreshPending();
    // Keep explicit, idempotent choices. Bound the queue while preserving every
    // distinct tool, even when a device stays offline for many edits.
    this.pending = this.pending.filter(old => {
      if (target(old.edit) !== target(edit)) return true;
      this.unsaved.delete(old.id);
      return false;
    });
    const entry = { id: crypto.randomUUID(), edit };
    this.pending.push(entry);
    this.unsaved.add(entry.id);
    this.saving = this.saving.then(async () => {
      try { await this.io.pending.put(entry); this.unsaved.delete(entry.id); }
      catch { (this.io.storageError ?? this.io.error)(); }
    });
    this.publish();
    void this.sync();
  }
  sync = (): Promise<void> => {
    if (this.running) return this.running;
    this.running = this.flush().catch(() => this.io.error()).finally(() => { this.running = null; });
    return this.running;
  };
  private async flush() {
    await this.saving;
    this.refreshPending();
    let remote = await this.io.read();
    if (remote === null && this.io.legacy !== null) {
      remote = await this.io.write({ kind: "import", preferences: parseSidebarPreferences(this.io.legacy) });
    }
    await this.saving;
    this.refreshPending();
    this.base = remote ?? empty();
    this.publish();
    while (this.pending.length) {
      const entry = this.pending[0]!;
      let remote: SidebarPreferences;
      try { remote = await this.io.write(entry.edit); }
      catch (error) {
        if (!this.io.isRejected?.(error)) throw error;
        await this.saving;
        await this.acknowledge(entry);
        this.io.rejected?.();
        this.publish();
        continue;
      }
      await this.saving;
      await this.acknowledge(entry);
      this.base = remote;
      this.publish();
    }
  }
}
