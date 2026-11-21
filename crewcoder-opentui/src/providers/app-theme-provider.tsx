import { useMemo, type ReactNode } from "react";
import { AppColorsContext } from "../hooks/use-app-colors.js";
import type { AppTheme } from "../theme.js";
import { ThemeProvider } from "./theme-provider.js";

/**
 * The active theme for the whole tree: termcn tokens through `ThemeProvider`
 * (`useTheme`) and diff/syntax/markdown/logo colors through `AppColorsContext`
 * (`useAppColors`). The theme is chosen once at startup.
 */
export function AppThemeProvider({ theme, children }: { theme: AppTheme; children: ReactNode }): ReactNode {
  const colors = useMemo(() => ({ diff: theme.diff, syntax: theme.syntax, markdown: theme.markdown, logo: theme.logo }), [theme]);
  return (
    <ThemeProvider theme={theme.ui}>
      <AppColorsContext.Provider value={colors}>{children}</AppColorsContext.Provider>
    </ThemeProvider>
  );
}
