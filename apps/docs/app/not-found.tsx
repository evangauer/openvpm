import Link from "next/link";
import { SearchButton } from "@/components/search";

export default function NotFound() {
  return (
    <div className="page max-w-2xl py-20 text-center">
      <h1 className="text-3xl font-bold">We couldn&apos;t find that page</h1>
      <p className="lede">It may have moved. Search for the task instead, or start from the home page.</p>
      <div className="mt-6 flex justify-center">
        <SearchButton variant="hero" placeholder="What do you need to do?" />
      </div>
      <Link href="/" className="text-link mt-6 inline-block">
        Back to OpenVPM Help
      </Link>
    </div>
  );
}
