/** @description Theme mode constants for next-themes ThemeProvider and ModeToggle. */

export type ThemeMode = "light" | "dark" | "system";

/** Default theme preference — follow OS until the user picks. */
export const DEFAULT_THEME: ThemeMode = "system";

/** Closed set of theme modes exposed in the shell ModeToggle. */
export const THEME_MODES = ["light", "dark", "system"] as const satisfies readonly ThemeMode[];
