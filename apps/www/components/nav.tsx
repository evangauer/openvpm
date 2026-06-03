"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Github, Menu, X } from "lucide-react";

function PawMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="16" rx="4.5" ry="3.5" />
      <ellipse cx="6" cy="9" rx="2" ry="2.5" />
      <ellipse cx="9.5" cy="4.5" rx="1.7" ry="2.2" />
      <ellipse cx="14.5" cy="4.5" rx="1.7" ry="2.2" />
      <ellipse cx="18" cy="9" rx="2" ry="2.5" />
    </svg>
  );
}

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://demo.openvpm.com";

const navLinks = [
  { label: "Features", href: "/features" },
  { label: "Install", href: "/install" },
  { label: "Why Open Source", href: "/why" },
  { label: "Writing", href: "/blog" },
  { label: "Updates", href: "/updates" },
];

export function MarketingNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-teal-600">
              <PawMark className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold font-heading text-gray-900 tracking-tight">
              OpenVPM
            </span>
          </Link>

          {/* Desktop links */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm transition-colors ${
                  pathname === link.href
                    ? "text-teal-600 font-medium"
                    : "text-gray-600 hover:text-teal-600"
                }`}
              >
                {link.label}
              </Link>
            ))}
            <a
              href="https://github.com/evangauer/openvpm"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-600 hover:text-teal-600 transition-colors inline-flex items-center gap-1"
            >
              <Github className="w-4 h-4" />
              GitHub
            </a>
          </div>

          {/* Desktop CTAs */}
          <div className="hidden md:flex items-center gap-3">
            <a
              href={`${appUrl}/login`}
              className="text-sm font-medium text-gray-700 hover:text-teal-600 transition-colors"
            >
              Sign In
            </a>
            <a
              href={`${appUrl}/register`}
              className="inline-flex items-center justify-center rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-teal-700 transition-colors"
            >
              Try the Demo
            </a>
          </div>

          {/* Mobile menu button */}
          <button
            className="md:hidden p-2 text-gray-600 hover:text-teal-600 transition-colors"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden border-t border-gray-100 bg-white">
          <div className="max-w-7xl mx-auto px-4 py-4 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                  pathname === link.href
                    ? "bg-teal-50 text-teal-700 font-medium"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {link.label}
              </Link>
            ))}
            <a
              href="https://github.com/evangauer/openvpm"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <Github className="w-4 h-4" />
              GitHub
            </a>
            <div className="pt-3 border-t border-gray-100 flex flex-col gap-2">
              <a
                href={`${appUrl}/login`}
                className="block px-3 py-2 text-sm font-medium text-gray-700 hover:text-teal-600 transition-colors"
              >
                Sign In
              </a>
              <a
                href={`${appUrl}/register`}
                className="block text-center rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-700 transition-colors"
              >
                Try the Demo
              </a>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
