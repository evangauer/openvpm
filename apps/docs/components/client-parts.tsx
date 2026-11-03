"use client";

import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

/** "On this page" list that follows the reader's place in the guide. */
export function OnThisPage({ items }: { items: { id: string; label: string }[] }) {
  const [active, setActive] = useState(items[0]?.id);

  useEffect(() => {
    const sections = items.map((i) => document.getElementById(i.id)).filter((el): el is HTMLElement => Boolean(el));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, [items]);

  return (
    <nav aria-label="On this page">
      <p className="mb-2 font-semibold text-[color:var(--ink)]">On this page</p>
      {items.map((item) => (
        <a key={item.id} href={`#${item.id}`} data-active={item.id === active}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}

export function Feedback({ title, email }: { title: string; email: string }) {
  const [answer, setAnswer] = useState<"yes" | "no" | null>(null);
  if (answer === "yes") return <p className="mt-8 text-sm text-muted-foreground">Thanks. Glad it helped.</p>;
  if (answer === "no")
    return (
      <p className="mt-8 text-sm text-muted-foreground">
        Sorry about that. Tell us what was missing at{" "}
        <a className="text-link" href={`mailto:${email}?subject=${encodeURIComponent(`Guide feedback: ${title}`)}`}>
          {email}
        </a>{" "}
        and we&apos;ll fix the guide.
      </p>
    );
  return (
    <div className="no-print mt-8 flex items-center gap-2.5 text-sm text-muted-foreground">
      Did this help?
      <button type="button" className="btn-ghost px-3 py-1.5 font-sans font-normal" onClick={() => setAnswer("yes")}>
        <ThumbsUp className="icon" aria-hidden="true" /> Yes
      </button>
      <button type="button" className="btn-ghost px-3 py-1.5 font-sans font-normal" onClick={() => setAnswer("no")}>
        <ThumbsDown className="icon" aria-hidden="true" /> Not quite
      </button>
    </div>
  );
}
