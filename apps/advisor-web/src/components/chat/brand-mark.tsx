import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// The app's logo mark: used in the sidebar, the welcome screen and as the avatar of every answer
export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center bg-linear-to-br from-primary to-primary/65 text-primary-foreground shadow-sm",
        className,
      )}
    >
      <Sparkles className="size-1/2" />
    </div>
  );
}
