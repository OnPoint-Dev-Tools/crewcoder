import { beforeEach, describe, expect, it, vi } from "vitest";
import { PickerOverlay } from "../components/PickerOverlay.js";
import { crewCoderTheme } from "../theme/theme.js";
import { fg, reset, stripAnsi, visibleLength } from "../tui/ansi.js";
import { padRight, truncate } from "../tui/layout.js";

const listCrewCoderSessions = vi.fn();

vi.mock("../bridge/crewcoder-process.js", () => ({
  listCrewCoderSessions
}));

const { SessionsOverlay } = await import("../components/SessionsOverlay.js");

describe("PickerOverlay", () => {
  it("scrolls the option window to keep keyboard selection visible", () => {
    const picker = new PickerOverlay(
      "Pick model",
      Array.from({ length: 20 }, (_, index) => ({ label: `model-${index}`, value: `model-${index}` })),
      () => {}
    );

    for (let i = 0; i < 5; i++) {
      picker.handleInput?.({ name: "down", sequence: "", ctrl: false, meta: false, shift: false });
    }

    const plain = picker.render({ theme: crewCoderTheme, size: { width: 40, height: 12 } }).map(stripAnsi);

    // The active row is rendered as a full-width highlight bar prefixed with ●.
    expect(plain.some((line) => line.startsWith("● model-5"))).toBe(true);
    // The window scrolled, so the first option is no longer visible.
    expect(plain.join("\n")).not.toContain("model-0");
    // Modal chrome is present.
    expect(plain[0]).toContain("Pick model");
    expect(plain[0]).toContain("esc");
  });
});

describe("SessionsOverlay", () => {
  beforeEach(() => {
    listCrewCoderSessions.mockReset();
  });

  it("truncates styled rows without cutting ANSI escape sequences", () => {
    const styled = `${fg(crewCoderTheme.accent)}abcdef${reset()}`;
    const result = truncate(styled, 4);

    expect(stripAnsi(result)).toBe("abc…");
    expect(visibleLength(result)).toBe(4);
    expect(stripAnsi(padRight(styled, 4))).toBe("abc…");
    expect(stripAnsi(result)).not.toContain("\x1b");
  });

  it("scrolls to keep the keyboard selection visible", async () => {
    listCrewCoderSessions.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `session_session-${index}`,
        startedAt: "2026-07-06T23:24:01.000Z",
        cwd: "/workspace/crewcoder",
        requestedMode: "general",
        resolvedMode: "general",
        prompt: `prompt-${index}`,
        provider: "openai-codex",
        model: "gpt-5.3-codex"
      }))
    );
    const overlay = new SessionsOverlay(() => {});
    await vi.waitFor(() => {
      expect(stripAnsi(overlay.render({ theme: crewCoderTheme, size: { width: 40, height: 9 } })[0] ?? ""))
        .toContain("Sessions");
    });

    for (let i = 0; i < 5; i++) {
      overlay.handleInput?.({ name: "down", sequence: "", ctrl: false, meta: false, shift: false });
    }

    const plain = overlay.render({ theme: crewCoderTheme, size: { width: 40, height: 9 } }).map(stripAnsi).join("\n");
    expect(plain).toContain("prompt-5");
    expect(plain).not.toContain("prompt-0");
  });

  it("keeps rows within the modal width on narrow terminals", async () => {
    listCrewCoderSessions.mockResolvedValue([{
      id: "session_2026-07-06T23-24-01-extra-long-id",
      startedAt: "2026-07-06T23:24:01.000Z",
      cwd: "/workspace/crewcoder",
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "A long prompt that must be truncated to fit the narrow session modal",
      provider: "openai-codex",
      model: "gpt-5.3-codex"
    }]);
    const overlay = new SessionsOverlay(() => {});
    await vi.waitFor(() => {
      expect(stripAnsi(overlay.render({ theme: crewCoderTheme, size: { width: 24, height: 9 } })[0] ?? ""))
        .toContain("Sessions");
    });

    const lines = overlay.render({ theme: crewCoderTheme, size: { width: 24, height: 9 } });
    expect(lines).toHaveLength(9);
    for (const line of lines) {
      expect(visibleLength(line)).toBe(24);
      expect(stripAnsi(line)).not.toContain("\x1b");
    }
  });
});
