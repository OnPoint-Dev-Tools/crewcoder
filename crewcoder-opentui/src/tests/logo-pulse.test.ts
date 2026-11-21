import { crewCoderTheme, lightCrewCoderTheme, slateCrewCoderTheme } from "@onpoint-dev-tools/crewcoder-tui-core/theme/crewcoder-theme";
import { describe, expect, it } from "vitest";
import { logoPulseColor, PULSE_FREEZE_MS, PULSE_PERIOD_MS, pulseClock, pulseFrozen } from "../logo-pulse.js";
import { toAppTheme } from "../theme.js";

describe("logo pulse colors", () => {
  it("breathes from the accent at half brightness up to the glow color", () => {
    const { logo } = toAppTheme(crewCoderTheme);
    expect(logo).toEqual({ dim: "#1a434f", bright: crewCoderTheme.glow });
    expect(toAppTheme(slateCrewCoderTheme).logo.bright).toBe(slateCrewCoderTheme.glow);
  });

  it("keeps the built-in static color: the peak is each theme's primary", () => {
    for (const theme of [crewCoderTheme, slateCrewCoderTheme]) expect(toAppTheme(theme).logo.bright).toBe(theme.primary);
  });

  it("hits the peak, the trough, and the midpoint at the right times", () => {
    const { logo } = toAppTheme(lightCrewCoderTheme);
    expect(logoPulseColor(logo, PULSE_PERIOD_MS / 4)).toBe(logo.bright);
    expect(logoPulseColor(logo, (PULSE_PERIOD_MS * 3) / 4)).toBe(logo.dim);
    const mid = logoPulseColor(logo, 0);
    expect(mid).not.toBe(logo.dim);
    expect(mid).not.toBe(logo.bright);
  });

  it("is a pure function of time and repeats every period", () => {
    const { logo } = toAppTheme(crewCoderTheme);
    expect(logoPulseColor(logo, 1234)).toBe(logoPulseColor(logo, 1234));
    expect(logoPulseColor(logo, 1234)).toBe(logoPulseColor(logo, 1234 + PULSE_PERIOD_MS * 3));
  });
});

describe("pulseClock", () => {
  const idleSince = 10_000;

  it("follows the clock while the user is active", () => {
    expect(pulseClock(idleSince, idleSince)).toBe(idleSince);
    expect(pulseClock(idleSince, idleSince + PULSE_FREEZE_MS - 1)).toBe(idleSince + PULSE_FREEZE_MS - 1);
    expect(pulseFrozen(idleSince, idleSince + PULSE_FREEZE_MS - 1)).toBe(false);
  });

  it("freezes on one frame after the idle limit", () => {
    const freezeAt = idleSince + PULSE_FREEZE_MS;
    expect(pulseFrozen(idleSince, freezeAt)).toBe(true);
    expect(pulseClock(idleSince, freezeAt)).toBe(freezeAt);
    expect(pulseClock(idleSince, freezeAt + 60_000)).toBe(freezeAt);
  });
});
