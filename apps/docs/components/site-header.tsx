"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Brand } from "./brand";
import { SearchButton } from "./search";

const links = [
  { href: "/guides", label: "Guides" },
  { href: "/training", label: "Team training" },
  { href: "/screens", label: "Screens" },
];

export function SiteHeader({ appUrl }: { appUrl: string }) {
  const pathname = usePathname();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  const current = (href: string) => (pathname === href || pathname.startsWith(href + "/") ? "page" : undefined);

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Brand />
        <nav className="top-nav" aria-label="Main">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={current(l.href)}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-1 justify-end md:justify-center lg:justify-end">
          <SearchButton />
        </div>
        <a href={appUrl} className="btn-ghost hidden md:inline-flex">
          Open OpenVPM <ArrowUpRight className="icon" aria-hidden="true" />
        </a>
        <button
          type="button"
          className="rounded-lg p-2 text-[color:var(--ink)] lg:hidden"
          aria-expanded={menu}
          aria-controls="mobile-menu"
          aria-label={menu ? "Close menu" : "Open menu"}
          onClick={() => setMenu((m) => !m)}
        >
          {menu ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>
      {menu && (
        <nav id="mobile-menu" className="border-t border-border bg-white px-5 py-3 lg:hidden" aria-label="Mobile">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={current(l.href)} className="block rounded-lg px-2 py-2.5 font-medium text-[color:var(--ink)]">
              {l.label}
            </Link>
          ))}
          <a href={appUrl} className="mt-1 flex items-center gap-1.5 rounded-lg px-2 py-2.5 font-medium text-primary">
            Open OpenVPM <ArrowUpRight className="icon" aria-hidden="true" />
          </a>
        </nav>
      )}
    </header>
  );
}
