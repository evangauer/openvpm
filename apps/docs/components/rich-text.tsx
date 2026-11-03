import Link from "next/link";
import { parseInline } from "@/lib/inline";

export function RichText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((token, i) => {
        switch (token.kind) {
          case "ui":
            return (
              <span key={i} className="ui-label">
                {token.value}
              </span>
            );
          case "bold":
            return <strong key={i}>{token.value}</strong>;
          case "link":
            return token.href.startsWith("/") ? (
              <Link key={i} href={token.href} className="text-link">
                {token.value}
              </Link>
            ) : (
              <a key={i} href={token.href} className="text-link">
                {token.value}
              </a>
            );
          case "ref":
            return (
              <span key={i} className="callout-ref" aria-label={`callout ${token.value}`}>
                {token.value}
              </span>
            );
          default:
            return token.value;
        }
      })}
    </>
  );
}
