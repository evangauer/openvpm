import {
  Archive,
  BarChart3,
  BellRing,
  Bot,
  Calendar,
  ClipboardList,
  FileText,
  FlaskConical,
  LayoutDashboard,
  MessageSquare,
  Package,
  PawPrint,
  Receipt,
  Settings,
  ShieldAlert,
  Syringe,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { AreaId } from "@/content/types";

/** The same icon each area has in the OpenVPM sidebar (apps/web/components/layout/sidebar.tsx). */
export const areaIcons: Record<AreaId, LucideIcon> = {
  dashboard: LayoutDashboard,
  patients: PawPrint,
  clients: Users,
  schedule: Calendar,
  records: FileText,
  "lab-inbox": FlaskConical,
  billing: Receipt,
  inventory: Package,
  inbox: MessageSquare,
  recalls: Syringe,
  "care-reminders": BellRing,
  "imported-history": Archive,
  whiteboard: ClipboardList,
  agent: Bot,
  "controlled-substances": ShieldAlert,
  reports: BarChart3,
  settings: Settings,
};

export function AreaIcon({ area, className = "icon" }: { area: AreaId; className?: string }) {
  const Icon = areaIcons[area];
  return <Icon className={className} aria-hidden="true" />;
}
