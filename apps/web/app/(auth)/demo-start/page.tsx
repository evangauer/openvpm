import { notFound } from "next/navigation";
import { DemoWelcome } from "@/components/demo/demo-welcome";

export default function DemoStartPage() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE?.trim() !== "true") notFound();
  return <DemoWelcome />;
}
