"use client";

import { useLanguage } from "@/components/language-provider";
import { LANGS } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function LanguageToggle() {
  const { lang, setLang, t } = useLanguage();

  return (
    <div role="group" aria-label={t.languageLabel} className="inline-flex shrink-0 rounded-lg border bg-muted/50 p-0.5 text-xs">
      {LANGS.map((l) => {
        const active = l.code === lang;
        return (
          <button
            key={l.code}
            aria-pressed={active}
            onClick={() => setLang(l.code)}
            className={cn(
              "rounded-md px-2.5 py-1 font-medium transition-colors",
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="sm:hidden">{l.short}</span>
            <span className="hidden sm:inline">{l.label}</span>
          </button>
        );
      })}
    </div>
  );
}
