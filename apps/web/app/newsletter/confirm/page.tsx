import type { Metadata } from "next";
import { NewsletterConfirmation } from "./newsletter-confirmation";

export const metadata: Metadata = { title: "Confirm your OpenVPM updates", robots: { index: false, follow: false } };
export default function Page() { return <NewsletterConfirmation />; }
