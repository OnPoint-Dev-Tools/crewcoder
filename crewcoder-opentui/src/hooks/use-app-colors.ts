import { createContext, useContext } from "react";
import { slateAppTheme, type AppTheme } from "../theme.js";

export type AppColors = Pick<AppTheme, "diff" | "syntax" | "markdown" | "logo">;

/** Diff, syntax, markdown, and logo colors; defaults to slate so components render without a provider. */
export const AppColorsContext = createContext<AppColors>({ diff: slateAppTheme.diff, syntax: slateAppTheme.syntax, markdown: slateAppTheme.markdown, logo: slateAppTheme.logo });

export const useAppColors = (): AppColors => useContext(AppColorsContext);
