import { spawnSync } from "node:child_process";
import type { FooterAlert } from "./alert-model.js";

/**
 * tmux settings OpenTUI needs, checked against a real attached client
 * (`docs/TMUX.md`). With tmux's defaults:
 *
 * - `set-clipboard external` drops clipboard writes from programs, so a mouse
 *   selection never reaches the system clipboard.
 * - `extended-keys off` delivers Shift+Enter as plain Enter, which sends the message.
 * - `focus-events off` hides focus changes, so the focus gate cannot tell when
 *   this pane is in the background.
 * - Without the `RGB` terminal feature tmux reduces 24-bit theme colors to 256.
 */
export type TmuxSettings = {
  setClipboard?: string;
  extendedKeys?: string;
  focusEvents?: string;
  /** `#{client_termfeatures}` of the attached client, e.g. `bpaste,clipboard,RGB,title`. */
  clientFeatures?: string;
};

export type TmuxIssue = { effect: string; fix: string };

/** Silence the startup hint: `CREWCODER_TUI_TMUX_HINT=0`. */
export const TMUX_HINT_ENV = "CREWCODER_TUI_TMUX_HINT";

export function tmuxIssues(settings: TmuxSettings): TmuxIssue[] {
  const issues: TmuxIssue[] = [];
  if (settings.setClipboard !== undefined && settings.setClipboard !== "on") {
    issues.push({ effect: "Mouse-select copy never reaches your clipboard", fix: "set -g set-clipboard on" });
  }
  if (settings.extendedKeys === "off") {
    issues.push({ effect: "Shift+Enter sends instead of adding a line (Ctrl+J still adds one)", fix: "set -g extended-keys on" });
  }
  if (settings.focusEvents === "off") {
    issues.push({ effect: "CrewCoder cannot tell when this pane is in the background", fix: "set -g focus-events on" });
  }
  if (settings.clientFeatures !== undefined && !settings.clientFeatures.split(",").includes("RGB")) {
    issues.push({ effect: "Theme colors are reduced to 256 colors", fix: "set -as terminal-features ',xterm*:RGB'  (then reattach)" });
  }
  return issues;
}

/** One startup alert listing what is missing and the tmux.conf lines that fix it. */
export function tmuxSettingsAlert(issues: readonly TmuxIssue[]): FooterAlert | undefined {
  if (!issues.length) return undefined;
  return {
    variant: "warning",
    title: `tmux: ${issues.length} setting${issues.length === 1 ? "" : "s"} missing for CrewCoder`,
    body: [
      ...issues.map((issue) => `• ${issue.effect}`),
      "",
      "Add to ~/.tmux.conf, then run: tmux source-file ~/.tmux.conf",
      ...issues.map((issue) => `  ${issue.fix}`),
      "",
      `Hide this with ${TMUX_HINT_ENV}=0.`
    ].join("\n")
  };
}

/** What a mouse copy really did: tmux without `set-clipboard on` drops it silently. */
export function copyAlert(characters: number, setClipboard: string | undefined): FooterAlert {
  if (setClipboard !== undefined && setClipboard !== "on") {
    return { variant: "warning", title: "Not copied: tmux blocks clipboard writes from programs", body: "Add `set -g set-clipboard on` to ~/.tmux.conf, or Shift+drag to use the terminal's own selection." };
  }
  return { variant: "info", title: `Copied ${characters} characters` };
}

/** Run a tmux query; undefined when it fails (no tmux, not attached, old version). */
function tmux(args: readonly string[]): string | undefined {
  const result = spawnSync("tmux", args, { encoding: "utf8", timeout: 1_000 });
  return result.status === 0 && !result.error ? result.stdout.trim() : undefined;
}

/** A tmux option: server scope first (where tmux keeps these), then global session scope. */
export function readTmuxOption(name: string): string | undefined {
  return tmux(["show-options", "-sqv", name]) || tmux(["show-options", "-gqv", name]) || undefined;
}

/** The settings above, or undefined outside tmux. Called at startup (a few quick queries). */
export function readTmuxSettings(env: NodeJS.ProcessEnv = process.env): TmuxSettings | undefined {
  if (!env.TMUX) return undefined;
  const pane = env.TMUX_PANE;
  return {
    setClipboard: readTmuxOption("set-clipboard"),
    extendedKeys: readTmuxOption("extended-keys"),
    focusEvents: readTmuxOption("focus-events"),
    // Empty with no client attached (a detached session): unknown, not "no RGB".
    clientFeatures: tmux(["display-message", "-p", ...(pane ? ["-t", pane] : []), "#{client_termfeatures}"]) || undefined
  };
}
