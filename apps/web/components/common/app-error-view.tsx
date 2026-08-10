"use client";

import * as React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/components/common/report-client-error";
import type { ClientErrorSource } from "@/lib/client-error-report";

export function AppErrorView({
  error,
  reset,
  source,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  source: ClientErrorSource;
}) {
  React.useEffect(() => {
    reportClientError(source, error);
  }, [error, source]);

  return (
    <main
      id="main-content"
      role="alert"
      aria-labelledby="app-error-title"
      className="flex min-h-screen flex-col items-center justify-center bg-surface p-8"
    >
      <div className="rounded-full bg-destructive/10 p-3">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div className="mt-4 text-center">
        <h1
          id="app-error-title"
          className="font-heading text-2xl font-semibold"
        >
          Something went wrong
        </h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          We logged the error. Try again, or return to the dashboard if it
          keeps happening.
        </p>
      </div>
      <Button onClick={reset} className="mt-6 gap-2">
        <RotateCcw className="h-4 w-4" />
        Try Again
      </Button>
    </main>
  );
}
