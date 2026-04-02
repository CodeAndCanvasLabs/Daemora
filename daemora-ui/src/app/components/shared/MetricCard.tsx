import { Card } from "@/app/components/ui/card";
import { type ReactNode } from "react";

interface MetricCardProps {
  icon: ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  color?: "primary" | "success" | "warning" | "destructive" | "info";
}

const COLOR_MAP = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
};

export function MetricCard({ icon, label, value, sub, color = "primary" }: MetricCardProps) {
  return (
    <Card className="bg-card/50 border-border p-4">
      <div className="flex items-center gap-3">
        <div className={`${COLOR_MAP[color]} opacity-80`}>{icon}</div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold text-foreground">{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
        </div>
      </div>
    </Card>
  );
}
