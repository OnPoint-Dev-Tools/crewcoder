#!/usr/bin/env node
import path from "node:path";
import { effortLevelsForModel, normalizeEffort } from "@onpoint-dev-tools/crewcoder-tui-core/state/effort-levels";
import { normalizeTuiMode } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { CrewCoderProcessBridge } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import { readCrewCoderRemoteConnection } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/remote-connection";
import { readGitLabel, readGitLabelAsync, readGitRepoName } from "@onpoint-dev-tools/crewcoder-tui-core/state/git-status";
import { createCliRenderer, type Selection } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { mouseEnabled, parseArgs, USAGE } from "./args.js";
import { spawnInTerminal } from "./hunk.js";
import { Root } from "./Root.js";
import { SessionController } from "./session-controller.js";
import { registerBundledGrammars } from "./syntax/grammars.js";
import { defaultThemeDirs, fileThemeStore, resolveStartupTheme } from "./theme-controller.js";
import { readCrewHandoff, systemTmux, type CrewHandoff } from "./tmux.js";
import { copyAlert, readTmuxOption, readTmuxSettings, TMUX_HINT_ENV, tmuxIssues, tmuxSettingsAlert } from "./tmux-check.js";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  // A crew handed over from another UI ("Run in tmux"). Read first: its CREWCODER_*
  // variables (agent binary, home, theme) must apply before anything reads them.
  const crew = parsed.crewFile ? readCrewHandoff(parsed.crewFile) : undefined;
  if (crew) Object.assign(process.env, crew.env);
  // Remote mode is resolved by the shared bridge from these variables.
  if (parsed.remote) process.env.CREWCODER_REMOTE = parsed.remote;
  if (parsed.remoteCwd) process.env.CREWCODER_REMOTE_CWD = parsed.remoteCwd;
  if (parsed.remoteBin) process.env.CREWCODER_REMOTE_BIN = parsed.remoteBin;
  // Before the renderer starts, so a bad --theme / CREWCODER_THEME fails with a
  // plain error on a normal screen. A saved pick that broke falls back to slate.
  const themeStore = fileThemeStore();
  const themeDirs = defaultThemeDirs();
  const startupTheme = resolveStartupTheme(parsed.theme, process.env.CREWCODER_THEME, themeStore, themeDirs);

  // Bundled Tree-sitter grammars (local files only) must be registered before
  // the first highlight starts OpenTUI's parser worker.
  registerBundledGrammars();
  const controller = new SessionController(new CrewCoderProcessBridge());
  controller.themes.configure(startupTheme, themeStore, themeDirs);
  if (startupTheme.warning) controller.alert({ variant: "warning", title: "Theme", body: startupTheme.warning });
  const remote = readCrewCoderRemoteConnection();
  if (remote) {
    // The workspace is `<target>:<cwd>` on the SSH host (sidebar footer, welcome
    // screen). Never inspect the local directory for it: no repo name, no git label.
    controller.state.cwd = remote.cwd;
    controller.state.remoteTarget = remote.target;
  } else {
    controller.state.gitRepo = readGitRepoName(controller.state.cwd);
    controller.state.gitLabel = readGitLabel(controller.state.cwd);
    controller.sidebar.gitLabelReader = readGitLabelAsync;
    // /crew and /team ask "here or tmux" only when tmux exists and the workspace is local.
    const launcher = systemTmux();
    const self = path.resolve(process.argv[1] ?? "");
    if (launcher) controller.crewTmux = { launcher, command: (file) => [process.execPath, ...process.execArgv, self, "--crew-file", file] };
  }
  if (crew) applyCrewSettings(controller, crew);
  // Full screen: the UI draws the whole conversation in a scrollbox, so tools
  // update in place and tool output can expand and collapse.
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    // CREWCODER_TUI_MOUSE=0 leaves the mouse to the terminal (native selection).
    useMouse: mouseEnabled(),
    backgroundColor: controller.themes.current.ui.colors.background,
    onDestroy: () => controller.dispose()
  });
  // The mouse belongs to the UI, so a finished drag selection is copied over
  // OSC 52 (most terminals; Shift+drag still uses the terminal's own selection).
  renderer.on("selection", (selection: Selection) => {
    const text = selection.getSelectedText();
    // Under tmux the write is dropped unless `set-clipboard on`; say so instead of "Copied".
    // Read at copy time so fixing tmux.conf works without a restart.
    if (text && renderer.copyToClipboardOSC52(text)) {
      controller.alert(copyAlert(text.length, process.env.TMUX ? readTmuxOption("set-clipboard") : undefined));
    }
  });
  // Inside tmux, say once which settings are missing (copy, Shift+Enter, focus, colors).
  const tmuxAlert = process.env[TMUX_HINT_ENV] === "0" ? undefined : tmuxSettingsAlert(tmuxIssues(readTmuxSettings() ?? {}));
  if (tmuxAlert && !controller.currentAlert) controller.alert(tmuxAlert);
  // /diff: Hunk takes over the terminal; the renderer gives it back afterwards.
  controller.runInTerminal = async (command, args, cwd) => {
    await renderer.suspend();
    try {
      return await spawnInTerminal(command, args, cwd);
    } finally {
      await renderer.resume();
    }
  };
  // /repaint: OpenTUI has no public full-redraw call, and a resize to the same
  // size is a no-op (0.9.2 only repaints when a different size was seen in
  // between). Resizing one row away and straight back reallocates the frame and
  // redraws every cell; both calls run before the next frame, so nothing flashes.
  controller.repaint = () => {
    const { terminalWidth: width, terminalHeight: height } = renderer;
    renderer.resize(width, Math.max(1, height - 1));
    renderer.resize(width, height);
  };
  const quit = (): void => {
    renderer.destroy();
    process.exit(0);
  };
  controller.quit = quit;
  // /theme previews and picks: the terminal area outside the React tree follows too.
  controller.themes.onChange = (theme) => renderer.setBackgroundColor(theme.ui.colors.background);
  createRoot(renderer).render(<Root controller={controller} onQuit={quit} />);
  // The handed-over crew starts right away, with the settings it was launched with.
  if (crew) controller.startCrew(crew.target, crew.task, crew.command);
}

/** The launching UI's provider, model, effort, mode, system prompt, and access. */
function applyCrewSettings(controller: SessionController, crew: CrewHandoff): void {
  const state = controller.state;
  state.provider = crew.provider;
  state.model = crew.model;
  state.effort = normalizeEffort(crew.effort, effortLevelsForModel(crew.provider, crew.model)) ?? state.effort;
  state.mode = normalizeTuiMode(crew.mode);
  state.systemPrompt = crew.systemPrompt;
  state.fullAccess = crew.fullAccess;
}

main().catch((error: unknown) => {
  process.stderr.write(`crewcoder-opentui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
