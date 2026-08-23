import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers/_app";
import { createTRPCContext } from "@/server/trpc";
import { captureTrpcError } from "@/lib/error-tracking";

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: createTRPCContext,
    // Only queries may be method-overridden; mutations remain POST-only.
    // The history-search client uses this to keep clinical terms out of URLs.
    allowMethodOverride: true,
    onError({ error, path, type }) {
      captureTrpcError({ error, path, type });
    },
  });
}

export { handler as GET, handler as POST };
