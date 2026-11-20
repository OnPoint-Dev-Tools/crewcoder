import { createContext, useContext } from "react";
import { slateAppTheme, type AppTheme } from "../theme.js";

export type AppColors = Pick<AppTheme, "diff" | "syntax" | "markdown">;

/** Diff, syntax, and markdown colors; defaults to slate so components render without a provider. */
export const AppColorsContext = createContext<AppColors>({ diff: slateAppTheme.diff, syntax: slateAppTheme.syntax, markdown: slateAppTheme.markdown });

export const useAppColors = (): AppColors => useContext(AppColorsContext);
