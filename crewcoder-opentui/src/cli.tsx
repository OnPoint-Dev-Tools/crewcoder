#!/usr/bin/env node
import { CrewCoderProcessBridge } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.js";
import { parseArgs, USAGE } from "./args.js";
import { footerModel } from "./footer-layout.js";
import { applyFooterHeight, footerSettled, prepareFooterForWrites } from "./footer-sizer.js";
import { ThemeProvider } from "./providers/theme-provider.js";
import { attachScrollback, ScrollbackWriter } from "./scrollback-writer.js";
import { SessionController } from "./session-controller.js";
import { applyTerminalBackground } from "./terminal-background.js";
import { gothamTheme } from "./theme.js";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  // Remote mode is resolved by the shared bridge from these variables.
  if (parsed.remote) process.env.CREWCODER_REMOTE = parsed.remote;
  if (parsed.remoteCwd) process.env.CREWCODER_REMOTE_CWD = parsed.remoteCwd;
  if (parsed.remoteBin) process.env.CREWCODER_REMOTE_BIN = parsed.remoteBin;

  const controller = new SessionController(new CrewCoderProcessBridge());
  // Before the renderer starts capturing stdout; restored on every exit path.
  const resetBackground = applyTerminalBackground(process.stdout, gothamTheme.colors.background);
  process.once("exit", resetBackground);
  // Split footer: settled transcript goes to the terminal's native scrollback,
  // and only the live region, composer, and status stay in the footer.
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    backgroundColor: gothamTheme.colors.background,
    // Open at full height: a fresh session starts on the welcome screen.
    footerHeight: Math.max(footerModel([], false).rows, process.stdout.rows || 0),
    onDestroy: () => controller.dispose()
  });
  // Pad a fresh screen so the conversation footer starts at the bottom (see ScrollbackWriter).
  const scrollback = new ScrollbackWriter(renderer, gothamTheme, () => renderer.terminalHeight - footerModel([], true).rows);
  const sizeFooter = (): void => applyFooterHeight(renderer, controller.state, scrollback);
  attachScrollback(controller, scrollback, {
    prepare: () => prepareFooterForWrites(renderer, controller.state),
    size: sizeFooter,
    settled: () => footerSettled(renderer)
  });
  renderer.on("resize", sizeFooter);
  const quit = (): void => {
    scrollback.dispose();
    renderer.destroy();
    resetBackground();
    process.exit(0);
  };
  createRoot(renderer).render(
    <ThemeProvider theme={gothamTheme}>
      <App controller={controller} scrollback={scrollback} onQuit={quit} />
    </ThemeProvider>
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`crewcoder-opentui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
