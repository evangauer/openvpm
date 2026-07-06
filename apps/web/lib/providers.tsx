"use client";

import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import superjson from "superjson";
import { CookieConsent } from "@/components/common/cookie-consent";
import { createAppQueryClient } from "./query-client";
import { trpc } from "./trpc";

export const ACTIVE_THEME = "light";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => createAppQueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
        }),
      ],
    })
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
            <CookieConsent />
          </ThemeProvider>
        </SessionProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
