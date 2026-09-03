import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

type PageResult = {
  offset: number;
  version: number;
};

const inventoryListKey = (offset: number) => [
  ["inventory", "list"],
  { input: { limit: 50, offset }, type: "query" },
];

const inventoryListFamilyKey = [["inventory", "list"]];

function waitForResult(
  observer: QueryObserver<PageResult>,
  predicate: (result: PageResult | undefined) => boolean,
): Promise<PageResult> {
  const current = observer.getCurrentResult().data;
  if (predicate(current)) return Promise.resolve(current as PageResult);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for query result"));
    }, 2_000);
    const unsubscribe = observer.subscribe((result) => {
      if (!predicate(result.data)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(result.data as PageResult);
    });
  });
}

describe("prescription product query refresh", () => {
  it("invalidates cached page zero and isolates a late obsolete page result", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 30_000 },
      },
    });
    let offset0Fetches = 0;
    let offset50Fetches = 0;
    let resolveLateOffset50: ((result: PageResult) => void) | undefined;
    const fetchOffset0 = async () => ({
      offset: 0,
      version: ++offset0Fetches,
    });
    const fetchOffset50 = async () => {
      offset50Fetches += 1;
      if (offset50Fetches === 1) {
        return { offset: 50, version: 1 };
      }
      return new Promise<PageResult>((resolve) => {
        resolveLateOffset50 = resolve;
      });
    };

    await queryClient.fetchQuery({
      queryKey: inventoryListKey(0),
      queryFn: fetchOffset0,
    });
    await queryClient.fetchQuery({
      queryKey: inventoryListKey(50),
      queryFn: fetchOffset50,
    });
    const observer = new QueryObserver<PageResult>(queryClient, {
      queryKey: inventoryListKey(50),
      queryFn: fetchOffset50,
    });
    const keepActive = observer.subscribe(() => undefined);

    const invalidation = queryClient.invalidateQueries({
      queryKey: inventoryListFamilyKey,
    });
    observer.setOptions({
      queryKey: inventoryListKey(0),
      queryFn: fetchOffset0,
    });

    const refreshed = await waitForResult(
      observer,
      (result) => result?.offset === 0 && result.version === 2,
    );
    expect(refreshed).toEqual({ offset: 0, version: 2 });
    expect(offset0Fetches).toBe(2);

    resolveLateOffset50?.({ offset: 50, version: 2 });
    await invalidation;
    expect(observer.getCurrentResult().data).toEqual({
      offset: 0,
      version: 2,
    });

    keepActive();
    queryClient.clear();
  });
});
