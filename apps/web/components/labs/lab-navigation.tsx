import Link from "next/link";
import { Button } from "@/components/ui/button";

/** The PDF inbox and ordered results are two views of the same lab workspace. */
export function LabNavigation({ active }: { active: "results" | "reports" }) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Lab workspace">
      <Button
        asChild
        variant={active === "results" ? "secondary" : "ghost"}
        size="sm"
      >
        <Link
          href="/lab-results"
          aria-current={active === "results" ? "page" : undefined}
        >
          Results &amp; follow-up
        </Link>
      </Button>
      <Button
        asChild
        variant={active === "reports" ? "secondary" : "ghost"}
        size="sm"
      >
        <Link
          href="/lab-reports"
          aria-current={active === "reports" ? "page" : undefined}
        >
          Report PDFs
        </Link>
      </Button>
    </nav>
  );
}
