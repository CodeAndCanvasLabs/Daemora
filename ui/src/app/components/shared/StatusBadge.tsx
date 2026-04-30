import { Badge } from "@/app/components/ui/badge";
import { cn } from "@/app/components/ui/utils";

const STATUS_STYLES: Record<string, string> = {
  // Success states
  active:     "bg-success/15 text-success border-success/30",
  completed:  "bg-primary/15 text-primary border-primary/30",
  connected:  "bg-success/15 text-success border-success/30",
  running:    "bg-success/15 text-success border-success/30",
  enabled:    "bg-success/15 text-success border-success/30",
  done:       "bg-primary/15 text-primary border-primary/30",
  healthy:    "bg-success/15 text-success border-success/30",

  // Warning states
  paused:     "bg-warning/15 text-warning border-warning/30",
  pending:    "bg-warning/15 text-warning border-warning/30",
  assigned:   "bg-warning/15 text-warning border-warning/30",
  working:    "bg-warning/15 text-warning border-warning/30",
  starting:   "bg-warning/15 text-warning border-warning/30",
  loading:    "bg-warning/15 text-warning border-warning/30",

  // Error states
  failed:     "bg-destructive/15 text-destructive border-destructive/30",
  error:      "bg-destructive/15 text-destructive border-destructive/30",
  blocked:    "bg-destructive/15 text-destructive border-destructive/30",
  disbanded:  "bg-destructive/15 text-destructive border-destructive/30",
  stopped:    "bg-destructive/15 text-destructive border-destructive/30",
  disabled:   "bg-destructive/15 text-destructive border-destructive/30",

  // Info states
  idle:       "bg-muted text-muted-foreground border-border",
  inactive:   "bg-muted text-muted-foreground border-border",
  unknown:    "bg-muted text-muted-foreground border-border",

  // Special
  coding:     "bg-info/15 text-info border-info/30",
  research:   "bg-info/15 text-info border-info/30",
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const style = STATUS_STYLES[status.toLowerCase()] || STATUS_STYLES.unknown;
  return (
    <Badge
      variant="outline"
      className={cn("text-xs font-medium border", style, className)}
    >
      {status}
    </Badge>
  );
}
