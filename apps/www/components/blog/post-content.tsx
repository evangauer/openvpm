import type { Block } from "@/lib/posts";

export function PostContent({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-5">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "h2":
            return (
              <h2
                key={i}
                className="text-xl sm:text-2xl font-bold font-heading text-gray-900 tracking-tight pt-2"
              >
                {block.text}
              </h2>
            );
          case "quote":
            return (
              <blockquote
                key={i}
                className="border-l-4 border-teal-300 pl-5 py-1 text-lg font-heading text-gray-700 italic"
              >
                {block.text}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={i} className="space-y-2 pl-1">
                {block.items.map((item, j) => (
                  <li key={j} className="flex items-start gap-2 text-gray-600 leading-relaxed">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            );
          default:
            return (
              <p key={i} className="text-gray-600 leading-relaxed text-[17px]">
                {block.text}
              </p>
            );
        }
      })}
    </div>
  );
}
