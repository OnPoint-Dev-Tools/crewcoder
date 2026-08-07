import { describe, expect, it } from "vitest";
import { renderBannerPulse, pulseClock, PULSE_FREEZE_MS, PULSE_PERIOD_MS } from "../components/logo-banner.js";
import { crewCoderTheme } from "../theme/theme.js";
import { stripAnsi } from "../tui/ansi.js";

const ART = ["██  ██", "██████"];

function countColors(line: string): number {
  return (line.match(/\x1b\[38;2;/g) ?? []).length;
}

describe("renderBannerPulse", () => {
  it("preserves the banner glyphs and centers each row", () => {
    const lines = renderBannerPulse(ART, 20, crewCoderTheme, 0);
    expect(lines).toHaveLength(ART.length);
    for (let i = 0; i < ART.length; i++) {
      const plain = stripAnsi(lines[i]!);
      expect(plain).toContain(ART[i]!);
      expect(plain).toHaveLength(20); // padded to the target width
      const leftPad = plain.length - plain.trimStart().length;
      expect(leftPad).toBeGreaterThan(0); // centered, not flush-left
    }
  });

  it("uses a single color per row (a pulse, not a sweep)", () => {
    const lines = renderBannerPulse(ART, 20, crewCoderTheme, 0);
    for (const line of lines) {
      expect(countColors(line)).toBe(1);
    }
  });

  it("animates: brightness changes between the trough and the peak", () => {
    const peak = renderBannerPulse(ART, 20, crewCoderTheme, PULSE_PERIOD_MS / 4).join("\n"); // sin = +1
    const trough = renderBannerPulse(ART, 20, crewCoderTheme, (PULSE_PERIOD_MS * 3) / 4).join("\n"); // sin = -1
    expect(peak).not.toBe(trough); // different ANSI coloring
    expect(stripAnsi(peak)).toBe(stripAnsi(trough)); // identical glyphs
  });

  it("is deterministic for a given timestamp", () => {
    const a = renderBannerPulse(ART, 20, crewCoderTheme, 1234).join("\n");
    const b = renderBannerPulse(ART, 20, crewCoderTheme, 1234).join("\n");
    expect(a).toBe(b);
  });
});

describe("pulseClock", () => {
  const idleSince = 10_000;

  it("passes time through while within the active window", () => {
    expect(pulseClock(idleSince, idleSince)).toBe(idleSince);
    expect(pulseClock(idleSince, idleSince + 1000)).toBe(idleSince + 1000);
    expect(pulseClock(idleSince, idleSince + PULSE_FREEZE_MS - 1)).toBe(idleSince + PULSE_FREEZE_MS - 1);
  });

  it("clamps to the freeze instant once idle past the threshold", () => {
    const freezeAt = idleSince + PULSE_FREEZE_MS;
    expect(pulseClock(idleSince, freezeAt)).toBe(freezeAt);
    expect(pulseClock(idleSince, freezeAt + 60_000)).toBe(freezeAt);
  });

  it("freezes the rendered banner to a single static frame after the threshold", () => {
    const idle = 0;
    const frozenA = renderBannerPulse(ART, 20, crewCoderTheme, pulseClock(idle, PULSE_FREEZE_MS + 5_000)).join("\n");
    const frozenB = renderBannerPulse(ART, 20, crewCoderTheme, pulseClock(idle, PULSE_FREEZE_MS + 90_000)).join("\n");
    expect(frozenA).toBe(frozenB); // identical despite time passing
  });
});
