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
    onError({ error, path, type }) {
      captureTrpcError({ error, path, type });
    },
  });
}

export { handler as GET, handler as POST };
