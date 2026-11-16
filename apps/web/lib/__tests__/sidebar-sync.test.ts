import { describe, expect, it, vi } from "vitest";
import { sidebarPendingStore, SidebarSync, type SidebarCommand } from "../sidebar-sync";
import { parseSidebarPreferences, serializeSidebarPreferences, type SidebarPreferences } from "../sidebar-pins";

function server(initial: SidebarPreferences | null = null) {
  let value = initial;
  return {
    read: vi.fn(async () => value),
    write: vi.fn(async (command: SidebarCommand) => {
      if (command.kind === "import") value ??= command.preferences;
      else {
        value ??= { layout: "full", pinned: [] };
        if (command.kind === "layout") value = { ...value, layout: command.layout };
        else value = { ...value, pinned: [...value.pinned.filter(p => p !== command.href), ...(command.pinned ? [command.href] : [])] };
      }
      return value!;
    }),
  };
}
function browserStorage() {
  const values = new Map<string, string>();
  let locked = Promise.resolve();
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
    withLock: (work: () => void) => {
      const result = locked.then(work);
      locked = result.catch(() => {});
      return result;
    },
  };
}
const setup = (remote: ReturnType<typeof server>, legacy: string | null = null, cached: string | null = null, browser = browserStorage()) => {
  const io = { ...remote, legacy, cached, pending: sidebarPendingStore(browser.storage, "sidebar-test", browser.withLock), save: vi.fn(), error: vi.fn(), rejected: vi.fn(), isRejected: (error: unknown) => error === "unavailable" };
  return { sync: new SidebarSync(io), io, browser };
};
const prefs = (sync: SidebarSync) => parseSidebarPreferences(sync.snapshot());

describe("account sidebar synchronization", () => {
  it("leaves untouched accounts Full without creating a preference", async () => {
    const remote = server(), { sync } = setup(remote);
    await sync.sync();
    expect(prefs(sync)).toEqual({ layout: "full", pinned: [] });
    expect(remote.write).not.toHaveBeenCalled();
  });
  it("imports old focused preferences once and lets the existing account win on another device", async () => {
    const remote = server();
    const a = setup(remote, '{"version":1,"pinned":["/inventory"]}').sync;
    await a.sync();
    const b = setup(remote, serializeSidebarPreferences({ layout: "full", pinned: ["/reports"] })).sync;
    await b.sync();
    expect(prefs(b)).toEqual({ layout: "focused", pinned: ["/inventory"] });
    expect(remote.write).toHaveBeenCalledTimes(1);
    b.edit({ kind: "pin", href: "/reports", pinned: true });
    await b.sync();
    await a.sync();
    expect(prefs(a).pinned).toEqual(["/inventory", "/reports"]);
  });
  it("does not let a slow initial read discard a newer local choice", async () => {
    const remote = server({ layout: "full", pinned: [] });
    let resolve!: (value: SidebarPreferences) => void;
    remote.read.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const { sync } = setup(remote);
    const run = sync.sync();
    await vi.waitFor(() => expect(remote.read).toHaveBeenCalled());
    sync.edit({ kind: "layout", layout: "focused" });
    resolve({ layout: "full", pinned: [] });
    await run;
    expect(prefs(sync).layout).toBe("focused");
  });
  it("retains failed edits across remount and retries idempotently", async () => {
    const remote = server({ layout: "full", pinned: [] });
    remote.write.mockRejectedValueOnce(new Error("offline"));
    const { sync, io, browser } = setup(remote);
    sync.edit({ kind: "pin", href: "/inventory", pinned: true });
    await sync.sync();
    expect(io.error).toHaveBeenCalled();
    const restored = setup(remote, null, io.save.mock.calls.at(-1)![0], browser).sync;
    await restored.sync();
    expect(prefs(restored).pinned).toEqual(["/inventory"]);
    expect(await remote.read()).toEqual(prefs(restored));
  });
  it("keeps a newer opposite choice when an earlier write completes late", async () => {
    const remote = server({ layout: "full", pinned: [] });
    let release!: (value: SidebarPreferences) => void;
    remote.write.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { sync } = setup(remote);
    sync.edit({ kind: "layout", layout: "focused" });
    await vi.waitFor(() => expect(remote.write).toHaveBeenCalledTimes(1));
    sync.edit({ kind: "layout", layout: "full" });
    release({ layout: "focused", pinned: [] });
    await sync.sync();
    expect(prefs(sync).layout).toBe("full");
    expect(remote.write).toHaveBeenLastCalledWith({ kind: "layout", layout: "full" });
  });
  it("isolates delayed responses to their original identity", async () => {
    const remoteA = server({ layout: "focused", pinned: ["/inventory"] });
    const remoteB = server();
    const a = setup(remoteA).sync, b = setup(remoteB).sync;
    await Promise.all([a.sync(), b.sync()]);
    expect(prefs(b)).toEqual({ layout: "full", pinned: [] });
    expect(prefs(a).layout).toBe("focused");
  });
  it("does not lose unsent edits when another tab refreshes its cache", async () => {
    const remote = server({ layout: "full", pinned: [] });
    const write = remote.write.getMockImplementation()!;
    remote.write.mockRejectedValue(new Error("offline"));
    const a = setup(remote);
    a.sync.edit({ kind: "pin", href: "/inventory", pinned: true });
    await a.sync.sync();
    const b = setup(remote, null, null, a.browser);
    await b.sync.sync();
    // Both tabs close after the second tab overwrites the ordinary cache.
    const restored = setup(remote, null, b.io.save.mock.calls.at(-1)![0], a.browser);
    remote.write.mockImplementation(write);
    await restored.sync.sync();
    expect(prefs(restored.sync).pinned).toEqual(["/inventory"]);
    expect(restored.io.pending.read()).toEqual([]);
  });
  it("does not acknowledge a newer unsent choice from another tab", async () => {
    const remote = server({ layout: "full", pinned: [] });
    const write = remote.write.getMockImplementation()!;
    let release!: (value: SidebarPreferences) => void;
    remote.write.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const a = setup(remote);
    a.sync.edit({ kind: "layout", layout: "focused" });
    await vi.waitFor(() => expect(remote.write).toHaveBeenCalledTimes(1));
    remote.write.mockRejectedValue(new Error("offline"));
    const b = setup(remote, null, null, a.browser);
    b.sync.edit({ kind: "layout", layout: "full" });
    await b.sync.sync();
    release({ layout: "focused", pinned: [] });
    await a.sync.sync();
    expect(a.io.pending.read().map(entry => entry.edit)).toEqual([{ kind: "layout", layout: "full" }]);
    remote.write.mockImplementation(write);
    const restored = setup(remote, null, null, a.browser);
    await restored.sync.sync();
    expect(await remote.read()).toEqual({ layout: "full", pinned: [] });
  });
  it("continues syncing other choices after the server rejects a role-restricted pin", async () => {
    const remote = server({ layout: "full", pinned: [] });
    let reject!: (error: unknown) => void;
    remote.write.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const { sync, io } = setup(remote);
    sync.edit({ kind: "pin", href: "/reports", pinned: true });
    await vi.waitFor(() => expect(remote.write).toHaveBeenCalledTimes(1));
    sync.edit({ kind: "layout", layout: "focused" });
    reject("unavailable");
    await sync.sync();
    expect(io.rejected).toHaveBeenCalledOnce();
    expect(io.error).not.toHaveBeenCalled();
    expect(prefs(sync)).toEqual({ layout: "focused", pinned: [] });
    expect(io.pending.read()).toEqual([]);
  });
  it("saves to the account when browser storage is blocked", async () => {
    const remote = server();
    const browser = browserStorage();
    browser.storage.getItem = () => { throw new Error("blocked"); };
    browser.storage.setItem = () => { throw new Error("blocked"); };
    const { sync } = setup(remote, null, null, browser);
    sync.edit({ kind: "layout", layout: "focused" });
    await sync.sync();
    expect(await remote.read()).toEqual({ layout: "focused", pinned: [] });
  });
});
