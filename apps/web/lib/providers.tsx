"use client";

import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, splitLink } from "@trpc/client";
import { SessionProvider, getSession, signOut } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import superjson from "superjson";
import { Analytics } from "@vercel/analytics/next";
import { filterVercelAnalyticsEvent } from "./analytics-privacy";
import { createAppQueryClient } from "./query-client";
import { trpc } from "./trpc";

export const ACTIVE_THEME = "light";

export function Providers({
  children,
  analyticsEnabled = false,
}: {
  children: React.ReactNode;
  analyticsEnabled?: boolean;
}) {
  const [queryClient] = useState(() => {
    let signingOut = false;
    return createAppQueryClient({
      // The server no longer accepts this browser's staff session (password
      // reset, role change, or deactivation). Clear the cookie and return to
      // sign-in instead of leaving every screen failing.
      onSessionRevoked: () => {
        if (signingOut) return;
        signingOut = true;
        // Only a browser that still holds a staff session cookie is signed
        // out; signed-out visitors on public pages stay where they are.
        void getSession()
          .then((session) =>
            session ? signOut({ callbackUrl: "/login" }) : undefined,
          )
          .finally(() => {
            signingOut = false;
          });
      },
    });
  });
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        splitLink({
          condition: (operation) =>
            [
              "records.searchPatientHistory",
              "visitTreatmentPlans.searchCatalog",
              "visitTreatmentPlans.quote",
            ].includes(operation.path),
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
            {analyticsEnabled ? (
              <Analytics beforeSend={filterVercelAnalyticsEvent} />
            ) : null}
          </ThemeProvider>
        </SessionProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
