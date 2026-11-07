export async function prepareOfflineShell(): Promise<void> {
  if (!window.isSecureContext || !("serviceWorker" in navigator))
    throw new Error(
      "This browser cannot prepare an offline workspace. Use a supported browser over HTTPS.",
    );
  const registration = await navigator.serviceWorker.register(
    "/offline/sw.js",
    { scope: "/offline/", updateViaCache: "none" },
  );
  if (registration.active) return checkInstalled(registration.active);
  const worker = registration.installing ?? registration.waiting;
  if (!worker)
    throw new Error(
      "Offline files are not ready. Reconnect and try preparing the chart again.",
    );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Offline files could not be prepared. Reconnect and try again.",
        ),
      );
    }, 20_000);
    const cleanup = () => {
      clearTimeout(timeout);
      worker.removeEventListener("statechange", check);
    };
    const check = () => {
      if (worker.state === "activated") {
        cleanup();
        resolve();
      }
      if (worker.state === "redundant") {
        cleanup();
        reject(
          new Error(
            "Offline file installation failed. Your existing saved charts have been kept.",
          ),
        );
      }
    };
    worker.addEventListener("statechange", check);
    check();
  });
  if (!registration.active) throw new Error("Offline files are not ready.");
  await checkInstalled(registration.active);
}

async function checkInstalled(worker: ServiceWorker) {
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(
        new Error(
          "Could not verify the offline files. Reconnect and try again.",
        ),
      );
    }, 10_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (event.data?.ready === true && event.data.schema === 1) resolve();
      else
        reject(
          new Error(
            "Some offline files are missing. Close other workspace tabs, reconnect, and try again.",
          ),
        );
    };
    worker.postMessage({ type: "CHECK_OFFLINE_SHELL" }, [channel.port2]);
  });
}
