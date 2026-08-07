import { beforeEach, describe, expect, it, vi } from "vitest";
import { fg, reset, stripAnsi, visibleLength } from "../tui/ansi.js";
import { box, padRight, truncate } from "../tui/layout.js";
import { crewCoderTheme } from "../theme/theme.js";

const listCrewCoderSessions = vi.fn();

vi.mock("../bridge/crewcoder-process.js", () => ({
  listCrewCoderSessions
}));

const { SessionsOverlay } = await import("../components/SessionsOverlay.js");

describe("ANSI-safe narrow layouts", () => {
  beforeEach(() => {
    listCrewCoderSessions.mockReset();
  });

  it("truncates styled text without cutting escape sequences", () => {
    const styled = `${fg(crewCoderTheme.accent)}abcdef${reset()}`;
    const result = truncate(styled, 4);

    expect(stripAnsi(result)).toBe("abc…");
    expect(visibleLength(result)).toBe(4);
    expect(stripAnsi(padRight(styled, 4))).toBe("abc…");
    expect(stripAnsi(result)).not.toContain("\x1b");
  });

  it("contains hard line breaks inside modal borders", () => {
    const lines = box(["first\nsecond\rthird\ttab\x1b[2Jbad"], 18, crewCoderTheme.border);

    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[1] ?? "")).toBe("│first second th…│");
    expect(lines[1]).not.toContain("\x1b[2J");
    expect(lines.every((line) => visibleLength(line) === 18)).toBe(true);
  });

  it("groups sessions by date with one aligned prompt and time row", async () => {
    const firstDay = new Date(2026, 7, 2, 18, 54);
    const secondDay = new Date(2026, 6, 8, 17, 12);
    listCrewCoderSessions.mockResolvedValue([
      {
        id: "session_first",
        startedAt: firstDay.toISOString(),
        cwd: "/workspace/crewcoder",
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "New session - first",
        provider: "openai-codex",
        model: "gpt-5.3-codex"
      },
      {
        id: "session_second",
        startedAt: new Date(2026, 7, 2, 18, 55).toISOString(),
        cwd: "/workspace/crewcoder",
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "New session - second",
        provider: "openai-codex",
        model: "gpt-5.3-codex"
      },
      {
        id: "session_ping",
        startedAt: secondDay.toISOString(),
        cwd: "/workspace/crewcoder",
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "Ping test",
        provider: "openai-codex",
        model: "gpt-5.3-codex"
      }
    ]);
    const overlay = new SessionsOverlay(() => {});
    await vi.waitFor(() => expect(listCrewCoderSessions).toHaveBeenCalledOnce());

    const plain = overlay.render({ theme: crewCoderTheme, size: { width: 60, height: 12 } }).map(stripAnsi);
    expect(plain).toContain("Sun Aug 02 2026".padEnd(60));
    expect(plain).toContain("Wed Jul 08 2026".padEnd(60));
    const selected = plain.find((line) => line.includes("New session - first")) ?? "";
    expect(selected.startsWith("● • New session - first")).toBe(true);
    expect(plain.some((line) => line.startsWith("  • New session - second"))).toBe(true);
    expect(selected.trimEnd()).toMatch(/6:54 PM$/);
  });

  it("keeps long descriptions to one bulleted, ellipsized row", async () => {
    listCrewCoderSessions.mockResolvedValue([{
      id: "session_ellipsized",
      startedAt: "2026-07-06T23:24:01.000Z",
      cwd: "/workspace/crewcoder",
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "A long session description that should not take over the list modal",
      provider: "openai-codex",
      model: "gpt-5.3-codex"
    }]);
    const overlay = new SessionsOverlay(() => {});
    await vi.waitFor(() => expect(listCrewCoderSessions).toHaveBeenCalledOnce());

    const plain = overlay.render({ theme: crewCoderTheme, size: { width: 40, height: 10 } }).map(stripAnsi);
    const descriptionRows = plain.filter((line) => line.includes("long session"));
    expect(descriptionRows).toHaveLength(1);
    expect(descriptionRows[0]).toMatch(/^● • A long session.*…\s+7:24 PM$/);
  });

  it("scrolls the session window to keep keyboard selection visible", async () => {
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
    await vi.waitFor(() => expect(listCrewCoderSessions).toHaveBeenCalledOnce());
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

  it("keeps session rows within the modal width on narrow terminals", async () => {
    listCrewCoderSessions.mockResolvedValue([
      {
        id: "session_2026-07-06T23-24-01-extra-long-id",
        startedAt: "2026-07-06T23:24:01.000Z",
        cwd: "/workspace/crewcoder",
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "A long prompt that must be truncated to fit the narrow session modal",
        provider: "openai-codex",
        model: "gpt-5.3-codex"
      }
    ]);
    const overlay = new SessionsOverlay(() => {});
    await vi.waitFor(() => expect(listCrewCoderSessions).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      const lines = overlay.render({ theme: crewCoderTheme, size: { width: 24, height: 9 } });
      expect(stripAnsi(lines[0] ?? "")).toContain("Sessions");
    });

    const lines = overlay.render({ theme: crewCoderTheme, size: { width: 24, height: 9 } });
    expect(lines).toHaveLength(9);
    for (const line of lines) {
      expect(visibleLength(line)).toBe(24);
      expect(stripAnsi(line)).not.toContain("\x1b");
    }
  });
});
