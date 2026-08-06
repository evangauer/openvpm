"use client";

import { useEffect, useState, useCallback } from "react";
import { X } from "lucide-react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { CommandSearch } from "@/components/common/command-search";
import { ErrorBoundary } from "@/components/common/error-boundary";
import { TourProvider } from "@/components/tour/tour-provider";
import { OnboardingJourneyProvider } from "@/components/onboarding/journey-overlay";
import { WelcomeProvider } from "@/components/welcome/welcome-provider";
import { BrandTheme } from "@/components/brand/brand-theme";
import { VerifyEmailBanner } from "@/components/layout/verify-email-banner";
import { DemoConversionBar } from "@/components/demo/demo-conversion-bar";
import { DemoFunnelTracker } from "@/components/demo/demo-funnel-tracker";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setSearchOpen((prev) => !prev);
    }
    if (e.key === "Escape") {
      setSearchOpen(false);
      setMobileNavOpen(false);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <TourProvider>
      <OnboardingJourneyProvider>
        <WelcomeProvider>
        <div className="flex h-screen overflow-hidden">
          <Sidebar className="hidden lg:flex" />
          {mobileNavOpen && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Main navigation"
              className="fixed inset-0 z-50 lg:hidden"
            >
              <button
                type="button"
                aria-label="Close navigation"
                className="absolute inset-0 bg-black/40"
                onClick={() => setMobileNavOpen(false)}
              />
              <div className="relative flex h-full w-72 max-w-[85vw] bg-surface shadow-xl">
                <Sidebar
                  className="h-full"
                  collapsible={false}
                  onNavigate={() => setMobileNavOpen(false)}
                  width="full"
                />
                <button
                  type="button"
                  aria-label="Close navigation"
                  className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setMobileNavOpen(false)}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
          <div className="flex flex-1 flex-col overflow-hidden">
            <TopBar
              onMenuOpen={() => setMobileNavOpen(true)}
              onSearchOpen={() => setSearchOpen(true)}
            />
            <DemoConversionBar />
            <DemoFunnelTracker />
            <VerifyEmailBanner />
            <main id="main-content" className="flex-1 overflow-y-auto bg-surface p-4 sm:p-6">
              <ErrorBoundary>{children}</ErrorBoundary>
            </main>
          </div>
          <CommandSearch
            open={searchOpen}
            onClose={() => setSearchOpen(false)}
          />
        </div>
        </WelcomeProvider>
      </OnboardingJourneyProvider>
      <BrandTheme />
    </TourProvider>
  );
}
