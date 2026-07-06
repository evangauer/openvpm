"use client";

import { AppErrorView } from "@/components/common/app-error-view";
import "@/styles/globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <AppErrorView error={error} reset={reset} source="global-error" />
      </body>
    </html>
  );
}
