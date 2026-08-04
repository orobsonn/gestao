/** @description Theme mode toggle — light / dark / system via next-themes. */

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { THEME_MODES, type ThemeMode } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MODE_LABELS: Record<ThemeMode, string> = {
  light: "Claro",
  dark: "Escuro",
  system: "Sistema",
};

/**
 * @description Dropdown to set theme from THEME_MODES (light, dark, system).
 */
export function ModeToggle() {
  const { setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Alternar tema">
          <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Alternar tema</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_MODES.map((mode) => (
          <DropdownMenuItem key={mode} onClick={() => setTheme(mode)}>
            {MODE_LABELS[mode]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
