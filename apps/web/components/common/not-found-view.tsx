import * as React from "react";
import Link from "next/link";
import { Home, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export function NotFoundView() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center bg-surface p-8"
    >
      <div className="rounded-full bg-primary/10 p-3">
        <SearchX className="h-6 w-6 text-primary" aria-hidden="true" />
      </div>
      <div className="mt-4 text-center">
        <p className="text-sm font-medium text-primary">404</p>
        <h1 className="mt-1 font-heading text-2xl font-semibold text-foreground">
          Page not found
        </h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          This page may have moved, or the link may no longer be available.
        </p>
      </div>
      <Button asChild className="mt-6 gap-2">
        <Link href="/">
          <Home className="h-4 w-4" aria-hidden="true" />
          Go to Dashboard
        </Link>
      </Button>
    </main>
  );
}
