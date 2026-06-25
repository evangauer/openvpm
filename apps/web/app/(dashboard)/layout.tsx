"use client";

import { useEffect, useState, useCallback } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { CommandSearch } from "@/components/common/command-search";
import { ErrorBoundary } from "@/components/common/error-boundary";
import { TourProvider } from "@/components/tour/tour-provider";
import { OnboardingJourney } from "@/components/onboarding/journey-overlay";
import { BrandTheme } from "@/components/brand/brand-theme";
import { VerifyEmailBanner } from "@/components/layout/verify-email-banner";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [searchOpen, setSearchOpen] = useState(false);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setSearchOpen((prev) => !prev);
    }
    if (e.key === "Escape") {
      setSearchOpen(false);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <TourProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar onSearchOpen={() => setSearchOpen(true)} />
          <VerifyEmailBanner />
          <main id="main-content" className="flex-1 overflow-y-auto bg-surface p-6">
            <ErrorBoundary>{children}</ErrorBoundary>
          </main>
        </div>
        <CommandSearch
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
        />
      </div>
      <OnboardingJourney />
      <BrandTheme />
    </TourProvider>
  );
}
