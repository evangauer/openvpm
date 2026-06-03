import Link from "next/link";
import { Heart, Github } from "lucide-react";

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

export function MarketingFooter() {
  return (
    <footer className="border-t border-gray-100 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-teal-600">
              <PawMark className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold font-heading text-gray-900 tracking-tight">
              OpenVPM
            </span>
          </Link>
          <div className="flex flex-wrap items-center justify-center gap-6 sm:gap-8">
            <Link href="/features" className="text-sm text-gray-500 hover:text-teal-600 transition-colors">
              Features
            </Link>
            <Link href="/install" className="text-sm text-gray-500 hover:text-teal-600 transition-colors">
              Install
            </Link>
            <Link href="/why" className="text-sm text-gray-500 hover:text-teal-600 transition-colors">
              Why Open Source
            </Link>
            <Link href="/blog" className="text-sm text-gray-500 hover:text-teal-600 transition-colors">
              Writing
            </Link>
            <Link href="/updates" className="text-sm text-gray-500 hover:text-teal-600 transition-colors">
              Updates
            </Link>
            <span className="text-sm text-gray-500">
              Pricing <span className="text-teal-600 font-medium">(free)</span>
            </span>
            <a
              href="https://github.com/evangauer/openvpm"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-500 hover:text-teal-600 transition-colors inline-flex items-center gap-1"
            >
              <Github className="w-4 h-4" />
              GitHub
            </a>
            <a
              href="mailto:evan@gettalky.ai"
              className="text-sm text-gray-500 hover:text-teal-600 transition-colors"
            >
              evan@gettalky.ai
            </a>
          </div>
        </div>
        <div className="mt-8 pt-8 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-gray-400 flex items-center gap-1">
            Built with <Heart className="w-3.5 h-3.5 text-red-400 fill-red-400" /> for the veterinary community
          </p>
          <p className="text-sm text-gray-400">
            &copy; 2026 OpenVPM. MIT Licensed.
          </p>
        </div>
      </div>
    </footer>
  );
}
