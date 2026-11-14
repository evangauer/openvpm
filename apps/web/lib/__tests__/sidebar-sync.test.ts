import { describe, expect, it, vi } from "vitest";
import { SidebarSync, type SidebarCommand } from "../sidebar-sync";
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
const setup = (remote: ReturnType<typeof server>, legacy: string | null = null, cached: string | null = null) => {
  const io = { ...remote, legacy, cached, save: vi.fn(), error: vi.fn() };
  return { sync: new SidebarSync(io), io };
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
    sync.edit({ kind: "layout", layout: "focused" });
    resolve({ layout: "full", pinned: [] });
    await run;
    expect(prefs(sync).layout).toBe("focused");
  });
  it("retains failed edits across remount and retries idempotently", async () => {
    const remote = server({ layout: "full", pinned: [] });
    remote.write.mockRejectedValueOnce(new Error("offline"));
    const { sync, io } = setup(remote);
    sync.edit({ kind: "pin", href: "/inventory", pinned: true });
    await sync.sync();
    expect(io.error).toHaveBeenCalled();
    const restored = setup(remote, null, io.save.mock.calls.at(-1)![0]).sync;
    await restored.sync();
    expect(prefs(restored).pinned).toEqual(["/inventory"]);
    expect(await remote.read()).toEqual(prefs(restored));
  });
  it("isolates delayed responses to their original identity", async () => {
    const remoteA = server({ layout: "focused", pinned: ["/inventory"] });
    const remoteB = server();
    const a = setup(remoteA).sync, b = setup(remoteB).sync;
    await Promise.all([a.sync(), b.sync()]);
    expect(prefs(b)).toEqual({ layout: "full", pinned: [] });
    expect(prefs(a).layout).toBe("focused");
  });
});
