import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const assets = [
  "/offline/index.html",
  "/offline/app.synthetic.js",
  "/offline/style.synthetic.css",
];
function worker(fail = false) {
  const handlers: Record<string, (event: any) => void> = {};
  const stores = new Map<string, Map<string, unknown>>();
  const fetch = vi.fn(async (request: Request) => {
    if (fail) throw new Error("Synthetic connection interruption");
    return {
      ok: true,
      redirected: false,
      url: request.url,
      headers: new Headers({
        "content-type": request.url.endsWith(".html")
          ? "text/html"
          : request.url.endsWith(".css")
            ? "text/css"
            : "application/javascript",
      }),
    };
  });
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const values = stores.get(name)!;
      return {
        match: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => {
          values.set(key, value);
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (key: string) => stores.delete(key),
  };
  const claim = vi.fn();
  const source = readFileSync("offline/worker.js", "utf8")
    .replace("__VERSION__", "test")
    .replace("__ASSETS__", JSON.stringify(assets));
  runInNewContext(source, {
    self: {
      location: { origin: "https://synthetic.invalid" },
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        handlers[type] = handler;
      },
      clients: { claim },
    },
    caches,
    fetch,
    URL,
    Request,
    Promise,
  });
  const lifecycle = async (name: string) => {
    let promise: Promise<void> | undefined;
    handlers[name]!({
      waitUntil: (value: Promise<void>) => {
        promise = value;
      },
    });
    await promise;
  };
  return { handlers, stores, fetch, claim, lifecycle };
}
describe("offline shell cache boundary", () => {
  it("precaches only the allowlisted public files without credentials", async () => {
    const app = worker();
    await app.lifecycle("install");
    expect([...app.stores.get("openvpm-offline-shell-test")!.keys()]).toEqual(
      assets,
    );
    expect(
      app.fetch.mock.calls.map(([request]) => [
        new URL(request.url).pathname,
        request.credentials,
      ]),
    ).toEqual(assets.map((asset) => [asset, "omit"]));
  });
  it("serves cached shell navigation but never handles API, patient, query, external, or mutation requests", async () => {
    const app = worker();
    await app.lifecycle("install");
    for (const [path, method] of [
      ["/api/trpc/offline.saveSoapDraft", "POST"],
      ["/api/auth/session", "GET"],
      ["/patients/synthetic", "GET"],
      ["/offline/index.html?patient=private", "GET"],
      ["https://external.invalid/offline/index.html", "GET"],
      ["/offline/index.html", "POST"],
    ]) {
      const respondWith = vi.fn();
      app.handlers.fetch!({
        request: new Request(new URL(path!, "https://synthetic.invalid"), {
          method,
        }),
        respondWith,
      });
      expect(respondWith).not.toHaveBeenCalled();
    }
    const respondWith = vi.fn();
    app.handlers.fetch!({
      request: new Request("https://synthetic.invalid/offline/index.html"),
      respondWith,
    });
    expect(await respondWith.mock.calls[0]![0]).toBe(
      app.stores.get("openvpm-offline-shell-test")!.get("/offline/index.html"),
    );
    expect(app.fetch).toHaveBeenCalledTimes(3);
  });
  it("fails installation closed and leaves unrelated caches intact", async () => {
    const app = worker(true);
    app.stores.set("unrelated-cache", new Map());
    await expect(app.lifecycle("install")).rejects.toThrow("interruption");
    expect([...app.stores.keys()]).toEqual(["unrelated-cache"]);
    expect(app.claim).not.toHaveBeenCalled();
  });
  it("cleans only old owned shells on activation and repairs evicted public assets", async () => {
    const app = worker();
    await app.lifecycle("install");
    app.stores.set("openvpm-offline-shell-old", new Map());
    app.stores.set("unrelated-cache", new Map());
    await app.lifecycle("activate");
    expect(app.stores.has("openvpm-offline-shell-old")).toBe(false);
    expect(app.stores.has("unrelated-cache")).toBe(true);
    app.stores.get("openvpm-offline-shell-test")!.delete(assets[1]!);
    let promise: Promise<void> | undefined;
    const postMessage = vi.fn();
    app.handlers.message!({
      data: { type: "CHECK_OFFLINE_SHELL" },
      ports: [{ postMessage }],
      waitUntil: (value: Promise<void>) => {
        promise = value;
      },
    });
    await promise;
    expect(postMessage).toHaveBeenCalledWith({ ready: true, schema: 1 });
    expect(app.stores.get("openvpm-offline-shell-test")!.has(assets[1]!)).toBe(
      true,
    );
  });
});
