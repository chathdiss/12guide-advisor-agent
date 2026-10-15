"use client";

import { ChevronDown, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/components/language-provider";
import { useTheme, type Theme } from "@/components/theme-provider";

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;
const ORDER: Theme[] = ["light", "dark", "system"];

export function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const { t } = useLanguage();

  const labels: Record<Theme, string> = { light: t.themeLight, dark: t.themeDark, system: t.themeSystem };
  const Current = ICONS[theme];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" aria-label={`${t.themeLabel}: ${labels[theme]}`} />}
      >
        <Current />
        <span className="hidden sm:inline">{labels[theme]}</span>
        <ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
          {ORDER.map((value) => {
            const Icon = ICONS[value];
            return (
              <DropdownMenuRadioItem key={value} value={value} closeOnClick>
                <Icon className="size-4 text-muted-foreground" />
                {labels[value]}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
