import { bigCrewCodeLogoLines } from "@onpoint-dev-tools/crewcoder-tui-core/theme/logo";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { homeComposerWidth, homeLogo } from "../footer-layout.js";
import { useAnimation } from "../hooks/use-animation.js";
import { useAppColors } from "../hooks/use-app-colors.js";
import { useMotion } from "../hooks/use-motion.js";
import { useTheme } from "../hooks/use-theme.js";
import { logoPulseColor, PULSE_FRAME_MS, pulseClock, pulseFrozen } from "../logo-pulse.js";

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
          <PulsingLogo lines={logo} />
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

/**
 * The wordmark breathing in one color (`logo-pulse.ts`). Only this component
 * re-renders per frame. The timer runs only while the logo is mounted, stops
 * after `PULSE_FREEZE_MS` without a key, and never starts under reduced motion
 * (`NO_MOTION=1`, `CI=true`), which shows the peak color.
 */
function PulsingLogo({ lines }: { lines: readonly string[] }): ReactNode {
  const { logo: colors } = useAppColors();
  const { reduced } = useMotion();
  const idleSince = useRef(Date.now());
  const [frozen, setFrozen] = useState(false);
  useAnimation({ intervalMs: PULSE_FRAME_MS, isActive: !frozen });
  // Any key restarts the freeze countdown; key handling itself stays in App.
  useKeyboard(() => {
    idleSince.current = Date.now();
    setFrozen(false);
  });
  const now = Date.now();
  useEffect(() => {
    if (!frozen && pulseFrozen(idleSince.current, Date.now())) setFrozen(true);
  });
  const color = reduced ? colors.bright : logoPulseColor(colors, pulseClock(idleSince.current, now));

  return (
    <>
      {lines.map((line, index) => (
        <text key={`logo-${index}`} fg={color} height={1} wrapMode="none" flexShrink={0}>
          <b>{line}</b>
        </text>
      ))}
    </>
  );
}
