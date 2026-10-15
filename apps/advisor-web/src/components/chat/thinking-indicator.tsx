"use client";

import { useLanguage } from "@/components/language-provider";
import { BrandMark } from "./brand-mark";

// Shown while the advisor is working, so the consultant never stares at a silent screen
export function ThinkingIndicator() {
  const { t } = useLanguage();

  return (
    <div className="flex gap-3" role="status" aria-live="polite">
      <BrandMark className="size-7 rounded-full" />
      <div className="flex items-center gap-2.5 pt-0.5 text-sm text-muted-foreground">
        <span className="flex items-center gap-1" aria-hidden>
          <span className="size-1.5 rounded-full bg-primary/70 motion-safe:animate-bounce [animation-delay:-0.3s]" />
          <span className="size-1.5 rounded-full bg-primary/70 motion-safe:animate-bounce [animation-delay:-0.15s]" />
          <span className="size-1.5 rounded-full bg-primary/70 motion-safe:animate-bounce" />
        </span>
        {t.thinking}
      </div>
    </div>
  );
}
