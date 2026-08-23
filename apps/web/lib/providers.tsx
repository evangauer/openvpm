"use client";

import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, splitLink } from "@trpc/client";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import superjson from "superjson";
import { Analytics } from "@vercel/analytics/next";
import { filterVercelAnalyticsEvent } from "./analytics-privacy";
import { createAppQueryClient } from "./query-client";
import { trpc } from "./trpc";

export const ACTIVE_THEME = "light";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => createAppQueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        splitLink({
          condition: (operation) =>
            operation.path === "records.searchPatientHistory",
          true: httpBatchLink({
            url: "/api/trpc",
            transformer: superjson,
            methodOverride: "POST",
          }),
          false: httpBatchLink({
            url: "/api/trpc",
            transformer: superjson,
          }),
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme={ACTIVE_THEME}
            forcedTheme={ACTIVE_THEME}
            enableSystem={false}
          >
            {children}
            <Toaster richColors position="bottom-right" />
            <Analytics beforeSend={filterVercelAnalyticsEvent} />
          </ThemeProvider>
        </SessionProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
