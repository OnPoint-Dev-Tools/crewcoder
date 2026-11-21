import { describe, expect, it } from "vitest";
import { copyAlert, tmuxIssues, tmuxSettingsAlert } from "../tmux-check.js";

// Values as tmux 3.8 reports them with no tmux.conf, and with the settings CrewCoder needs.
const defaults = { setClipboard: "external", extendedKeys: "off", focusEvents: "off", clientFeatures: "bpaste,ccolour,clipboard,cstyle,focus,title" };
const configured = { setClipboard: "on", extendedKeys: "on", focusEvents: "on", clientFeatures: "bpaste,ccolour,clipboard,cstyle,focus,RGB,title" };

describe("tmux settings check", () => {
  it("lists each default that breaks something, with the line that fixes it", () => {
    expect(tmuxIssues(defaults).map((issue) => issue.fix)).toEqual([
      "set -g set-clipboard on",
      "set -g extended-keys on",
      "set -g focus-events on",
      "set -as terminal-features ',xterm*:RGB'  (then reattach)"
    ]);
    expect(tmuxIssues(configured)).toEqual([]);
    // `always` also delivers extended keys.
    expect(tmuxIssues({ ...configured, extendedKeys: "always" })).toEqual([]);
  });

  it("stays quiet about what it could not read", () => {
    expect(tmuxIssues({})).toEqual([]);
  });

  it("says once what is missing, how to fix it, and how to hide the note", () => {
    expect(tmuxSettingsAlert([])).toBeUndefined();
    const alert = tmuxSettingsAlert(tmuxIssues(defaults));
    expect(alert).toMatchObject({ variant: "warning", title: "tmux: 4 settings missing for CrewCoder" });
    expect(alert?.body).toContain("Shift+Enter sends instead of adding a line (Ctrl+J still adds one)");
    expect(alert?.body).toContain("  set -g set-clipboard on");
    expect(alert?.body).toContain("CREWCODER_TUI_TMUX_HINT=0");
  });

  it("never claims a copy that tmux dropped", () => {
    expect(copyAlert(40, undefined)).toEqual({ variant: "info", title: "Copied 40 characters" });
    expect(copyAlert(40, "on")).toEqual({ variant: "info", title: "Copied 40 characters" });
    expect(copyAlert(40, "external")).toMatchObject({ variant: "warning", title: "Not copied: tmux blocks clipboard writes from programs" });
  });
});
