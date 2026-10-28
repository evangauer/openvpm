import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("react");
  vi.resetModules();
});

it("removes only one history entry when saving runs effect cleanup and the clean effect", async () => {
  // Drive the React effect lifecycle while leaving history.back asynchronous,
  // as in a real browser. Two back calls can leave a newly opened chart.
  let effect: (() => void | (() => void)) | undefined;
  const token = { current: Symbol("test guard") };
  vi.doMock("react", () => ({
    useRef: () => token,
    useEffect: (callback: typeof effect) => {
      effect = callback;
    },
  }));
  const back = vi.fn();
  const history = { state: {}, pushState: vi.fn(), back };
  const windowEvents = new EventTarget();
  vi.stubGlobal("window", {
    history,
    location: { href: "http://localhost/patients/synthetic" },
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  });
  vi.stubGlobal("document", new EventTarget());
  const { useUnsavedChangesGuard } =
    await import("../use-unsaved-changes-guard");

  useUnsavedChangesGuard(true);
  const cleanup = effect!();
  expect(history.pushState).toHaveBeenCalledOnce();
  if (typeof cleanup === "function") cleanup();
  useUnsavedChangesGuard(false);
  effect!();
  expect(back).toHaveBeenCalledOnce();
});
