import { bigCrewCodeLogoLines } from "@onpoint-dev-tools/crewcoder-tui-core/theme/logo";
import type { ReactNode } from "react";
import { homeComposerWidth, homeLogo } from "../footer-layout.js";
import { useTheme } from "../hooks/use-theme.js";

export type HomeProps = {
  width: number;
  height: number;
  /** Muted identity line under the tip, e.g. `provider · model · cwd`. */
  info: string;
  /** The composer, rendered centered at the home width. */
  composer: ReactNode;
  /** A status alert, shown above the composer. */
  alert?: ReactNode;
  /** Rows the alert and extra composer lines add, so the logo only shows when everything fits. */
  extraRows?: number;
};

/**
 * The fresh-session welcome screen: the CrewCoder logo centered in a footer
 * that fills the terminal, with the composer beneath it, mirroring the legacy
 * landing page. It disappears as soon as the session has any block. On windows
 * too small for the wordmark only the composer is shown.
 */
export function Home({ width, height, info, composer, alert, extraRows = 0 }: HomeProps): ReactNode {
  const theme = useTheme();
  const logo = homeLogo(width, height, bigCrewCodeLogoLines, extraRows);
  const composerWidth = homeComposerWidth(width);

  return (
    <box flexDirection="column" width="100%" height="100%" justifyContent="center" alignItems="center">
      {logo ? (
        <>
          {logo.map((line, index) => (
            <text key={`logo-${index}`} fg={theme.colors.primary} height={1} wrapMode="none" flexShrink={0}>
              <b>{line}</b>
            </text>
          ))}
          <box height={1} flexShrink={0} />
        </>
      ) : null}
      <box width={composerWidth} flexDirection="column" flexShrink={0}>
        {alert}
        {composer}
      </box>
      <box height={2} flexShrink={0} />
      <text height={1} wrapMode="none" flexShrink={0}>
        <span fg={theme.colors.accent}>Tip</span>
        <span fg={theme.colors.mutedForeground}> Type your first request below and press Enter</span>
      </text>
      <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>{info}</text>
    </box>
  );
}
