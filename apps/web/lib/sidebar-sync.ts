import { TOOL_PATHS } from "./navigation";
import { parseSidebarPreferences, serializeSidebarPreferences, type SidebarPreferences, type SidebarLayout } from "./sidebar-pins";

export type SidebarEdit = { kind: "layout"; layout: SidebarLayout } | { kind: "pin"; href: string; pinned: boolean };
export type SidebarCommand = SidebarEdit | { kind: "import"; preferences: SidebarPreferences };
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

/** One identity's cache and retry queue. Legacy v1 storage is never overwritten. */
export class SidebarSync {
  private base = empty();
  private pending: SidebarEdit[] = [];
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private raw = EMPTY_SIDEBAR;
  constructor(private io: {
    legacy: string | null;
    cached: string | null;
    read: () => Promise<SidebarPreferences | null>;
    write: (command: SidebarCommand) => Promise<SidebarPreferences>;
    save: (raw: string) => void;
    error: () => void;
    storageError?: () => void;
  }) {
    this.base = parseSidebarPreferences(io.legacy);
    try {
      if (io.cached && io.cached.length <= 65536) {
        const cached = JSON.parse(io.cached);
        if (cached.version === 2 && Array.isArray(cached.pending) && cached.pending.length <= 64 && cached.pending.every(validEdit)) {
          this.base = parseSidebarPreferences(JSON.stringify(cached.preferences));
          this.pending = cached.pending;
        }
      }
    } catch { /* Keep original browser preference on malformed cache. */ }
    this.publish(false);
  }
  snapshot = () => this.raw;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(save = true) {
    const current = this.pending.reduce(apply, this.base);
    this.raw = serializeSidebarPreferences(current);
    if (save) {
      try { this.io.save(JSON.stringify({ version: 2, preferences: JSON.parse(serializeSidebarPreferences(this.base)), pending: this.pending })); }
      catch { (this.io.storageError ?? this.io.error)(); }
    }
    this.listeners.forEach(listener => listener());
  }
  edit(edit: SidebarEdit) {
    if (!validEdit(edit)) return;
    // Keep explicit, idempotent choices. Bound the queue while preserving every
    // distinct tool, even when a device stays offline for many edits.
    this.pending = this.pending.filter(old => old.kind !== edit.kind || (old.kind === "pin" && edit.kind === "pin" && old.href !== edit.href));
    this.pending.push(edit);
    this.publish();
    void this.sync();
  }
  sync = (): Promise<void> => {
    if (this.running) return this.running;
    this.running = this.flush().catch(() => this.io.error()).finally(() => { this.running = null; });
    return this.running;
  };
  private async flush() {
    let remote = await this.io.read();
    if (remote === null && this.io.legacy !== null) {
      remote = await this.io.write({ kind: "import", preferences: parseSidebarPreferences(this.io.legacy) });
    }
    this.base = remote ?? empty();
    this.publish();
    while (this.pending.length) {
      const edit = this.pending[0]!;
      const remote = await this.io.write(edit);
      // An edit may have been replaced while its network request was pending.
      this.pending = this.pending.filter(item => item !== edit);
      this.base = remote;
      this.publish();
    }
  }
}
