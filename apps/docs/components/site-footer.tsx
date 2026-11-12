import Link from "next/link";
import { CircleHelp, Mail } from "lucide-react";
import { SUPPORT_EMAIL } from "@/content/catalog";
import { PawMark } from "./brand";

export function SiteFooter() {
  return (
    <footer className="no-print mt-8 border-t border-border bg-white">
      <div className="page flex flex-col gap-6 py-10 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <CircleHelp className="h-5 w-5 text-primary" aria-hidden="true" />
          <p className="text-sm">
            <strong className="font-heading text-[color:var(--ink)]">Still stuck?</strong> A real person reads every message.
          </p>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="btn-ghost ml-1">
            <Mail className="icon" aria-hidden="true" /> {SUPPORT_EMAIL}
          </a>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground" aria-label="Footer">
          <Link href="/guides" className="hover:text-foreground">Guides</Link>
          <Link href="/training" className="hover:text-foreground">Team training</Link>
          <Link href="/screens" className="hover:text-foreground">Screens</Link>
          <a href="https://github.com/evangauer/openvpm" className="hover:text-foreground">Source on GitHub</a>
          <span className="flex items-center gap-1.5">
            <PawMark className="h-3.5 w-3.5 text-[color:var(--mark)]" /> OpenVPM is free, open-source software
          </span>
        </nav>
      </div>
    </footer>
  );
}
