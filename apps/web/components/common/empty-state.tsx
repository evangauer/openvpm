import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: LucideIcon;
  };
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  const ActionIcon = action?.icon;
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card p-12 text-center",
        className
      )}
    >
      <Icon className="h-10 w-10 text-muted-foreground/50" />
      <p className="mt-3 font-medium text-muted-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground/70">
          {description}
        </p>
      )}
      {action && (
        <Button size="sm" className="mt-4" onClick={action.onClick}>
          {ActionIcon ? <ActionIcon className="mr-2 h-4 w-4" /> : null}
          {action.label}
        </Button>
      )}
    </div>
  );
}
