/* Public application files only. Never cache an authenticated response, API,
 * patient page, session, credential, or mutation. Scope is /offline/ only. */
const CACHE = "openvpm-offline-shell-__VERSION__";
const ASSETS = __ASSETS__;
async function downloadShell() {
  const responses = await Promise.all(
    ASSETS.map(async (path) => {
      const response = await fetch(
        new Request(new URL(path, self.location.origin), {
          credentials: "omit",
          cache: "reload",
        }),
      );
      const expectedType = path.endsWith(".html")
        ? "text/html"
        : path.endsWith(".css")
          ? "text/css"
          : "javascript";
      if (
        !response.ok ||
        response.redirected ||
        new URL(response.url).origin !== self.location.origin ||
        !response.headers.get("content-type")?.includes(expectedType)
      )
        throw new Error("Offline shell unavailable");
      return [path, response];
    }),
  );
  const cache = await caches.open(CACHE);
  for (const [path, response] of responses) await cache.put(path, response);
}
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await downloadShell();
      } catch (error) {
        await caches.delete(CACHE);
        throw error;
      }
    })(),
  );
  // Updates wait for old clients to close; never swap code underneath a note.
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("openvpm-offline-shell-") && name !== CACHE)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.search ||
    !ASSETS.includes(url.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(url.pathname)) ?? fetch(event.request);
    })(),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type !== "CHECK_OFFLINE_SHELL" || !event.ports?.[0]) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      let ready = (
        await Promise.all(ASSETS.map((path) => cache.match(path)))
      ).every(Boolean);
      if (!ready) {
        try {
          await downloadShell();
          ready = true;
        } catch {
          ready = false;
        }
      }
      event.ports[0].postMessage({ ready, schema: 1 });
    })(),
  );
});
