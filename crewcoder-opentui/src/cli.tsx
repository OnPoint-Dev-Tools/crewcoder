#!/usr/bin/env node
import { CrewCoderProcessBridge } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import { createCliRenderer, type Selection } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.js";
import { parseArgs, USAGE } from "./args.js";
import { spawnInTerminal } from "./hunk.js";
import { ThemeProvider } from "./providers/theme-provider.js";
import { SessionController } from "./session-controller.js";
import { slateTheme } from "./theme.js";

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
  // Full screen: the UI draws the whole conversation in a scrollbox, so tools
  // update in place and tool output can expand and collapse.
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    useMouse: true,
    backgroundColor: slateTheme.colors.background,
    onDestroy: () => controller.dispose()
  });
  // The mouse belongs to the UI, so a finished drag selection is copied over
  // OSC 52 (most terminals; Shift+drag still uses the terminal's own selection).
  renderer.on("selection", (selection: Selection) => {
    const text = selection.getSelectedText();
    if (text && renderer.copyToClipboardOSC52(text)) controller.alert({ variant: "info", title: `Copied ${text.length} characters` });
  });
  // /diff: Hunk takes over the terminal; the renderer gives it back afterwards.
  controller.runInTerminal = async (command, args, cwd) => {
    await renderer.suspend();
    try {
      return await spawnInTerminal(command, args, cwd);
    } finally {
      await renderer.resume();
    }
  };
  const quit = (): void => {
    renderer.destroy();
    process.exit(0);
  };
  createRoot(renderer).render(
    <ThemeProvider theme={slateTheme}>
      <App controller={controller} onQuit={quit} />
    </ThemeProvider>
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`crewcoder-opentui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
