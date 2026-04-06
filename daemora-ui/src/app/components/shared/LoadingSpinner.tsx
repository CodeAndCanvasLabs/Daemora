import { Loader2 } from "lucide-react";

interface LoadingSpinnerProps {
  text?: string;
  size?: "sm" | "md" | "lg";
}

const SIZE_MAP = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};

export function LoadingSpinner({ text, size = "md" }: LoadingSpinnerProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <Loader2 className={`${SIZE_MAP[size]} animate-spin text-primary`} />
      {text && <p className="text-sm text-muted-foreground">{text}</p>}
    </div>
  );
}
