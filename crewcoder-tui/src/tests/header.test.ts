import { describe, expect, it } from "vitest";
import { Header } from "../components/Header.js";
import { compactCrewCodeLogoLines, miniCrewCodeLogoLines } from "../theme/logo.js";
import { crewCoderTheme } from "../theme/theme.js";
import { stripAnsi } from "../tui/ansi.js";
import { createInitialState } from "../state/tui-store.js";

describe("Header", () => {
  it("renders standalone header branding without session status", () => {
    const lines = new Header().render({ theme: crewCoderTheme, size: { width: 100, height: 8 } }).map(stripAnsi);

    expect(lines).toHaveLength(compactCrewCodeLogoLines.length + 2);
    expect(lines[0]).toContain(compactCrewCodeLogoLines[0]!);
    expect(lines[1]).toContain(compactCrewCodeLogoLines[1]!);
    expect(lines.join("\n")).toContain("Code with a Crew · Local Tools · Any Provider");
    expect(lines.at(-1)).toBe("─".repeat(100));
  });

  it("includes persistent session status when connected to app state", () => {
    const state = createInitialState();
    state.worker = "Builder";
    state.gitLabel = "feature/sticky-header*";
    state.safetyPolicies = [{ extensionId: "safe", policyId: "env", title: "Protect env", action: "block", tools: [], paths: [".env"], commands: [] }];
    state.liveUiFocus = { instanceId: "i1", key: "live:1", extensionId: "ui", contributionId: "panel", surface: "modal", title: "review-panel", permissions: { ui: ["render"] } };

    const lines = new Header(state).render({ theme: crewCoderTheme, size: { width: 220, height: 8 } }).map(stripAnsi).join("\n");

    const rendered = lines.split("\n");
    expect(rendered.slice(0, compactCrewCodeLogoLines.length).join("\n")).not.toContain("MODE:");
    expect(rendered.slice(0, compactCrewCodeLogoLines.length).join("\n")).not.toContain("~/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-tui");
    expect(rendered.slice(compactCrewCodeLogoLines.length).join("\n")).toContain("Code with a Crew · Local Tools · Any Provider");
    expect(lines).not.toContain("MODEL:");
    expect(lines).not.toContain("GIT:");
    expect(lines).not.toContain("RUNTIME:");
    expect(lines).not.toContain("SAFETY");
    expect(lines).not.toContain("LIVE UI");
  });

  it("keeps the compact title beside the mini logo on narrow terminals", () => {
    const lines = new Header().render({ theme: crewCoderTheme, size: { width: 40, height: 6 } }).map(stripAnsi);

    const titleRow = Math.floor(miniCrewCodeLogoLines.length / 2);
    expect(lines).toHaveLength(miniCrewCodeLogoLines.length + 2);
    expect(lines[titleRow]).toContain(miniCrewCodeLogoLines[titleRow]!);
    expect(lines.every((line) => line.length <= 40)).toBe(true);
    expect(lines.at(-1)).toBe("─".repeat(40));
  });
});
