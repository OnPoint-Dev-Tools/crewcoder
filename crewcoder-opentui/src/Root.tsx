import { useSyncExternalStore, type ReactNode } from "react";
import { App } from "./App.js";
import { AppThemeProvider } from "./providers/app-theme-provider.js";
import type { SessionController } from "./session-controller.js";

/**
 * The app under the controller's current theme. It subscribes to the
 * controller so a `/theme` preview or pick re-themes the whole tree at once.
 */
export function Root({ controller, onQuit }: { controller: SessionController; onQuit: () => void }): ReactNode {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  return (
    <AppThemeProvider theme={controller.themes.current}>
      <App controller={controller} onQuit={onQuit} />
    </AppThemeProvider>
  );
}
