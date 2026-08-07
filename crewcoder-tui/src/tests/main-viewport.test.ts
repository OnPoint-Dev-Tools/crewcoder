import { describe, expect, it } from "vitest";
import { Header } from "../components/Header.js";
import { MainViewport } from "../components/MainViewport.js";
import { SPINNER_FRAMES } from "../components/Spinner.js";
import { createInitialState } from "../state/tui-store.js";
import { bg, bold, fg, italic, stripAnsi } from "../tui/ansi.js";
import { compactCrewCodeLogoLines, miniCrewCodeLogoLines } from "../theme/logo.js";
import { crewCoderTheme, lightCrewCoderTheme } from "../theme/theme.js";

describe("Header", () => {
  it("renders standalone branding beside the compact logo", () => {
    const lines = new Header().render({ theme: crewCoderTheme, size: { width: 100, height: 8 } }).map(stripAnsi);

    expect(lines).toHaveLength(compactCrewCodeLogoLines.length + 2);
    expect(lines[0]).toContain(compactCrewCodeLogoLines[0]!);
    expect(lines[1]).toContain(compactCrewCodeLogoLines[1]!);
    expect(lines.join("\n")).toContain("Code with a Crew · Local Tools · Any Provider");
  });

  it("keeps the mini logo within narrow terminals", () => {
    const lines = new Header().render({ theme: crewCoderTheme, size: { width: 40, height: 6 } }).map(stripAnsi);

    const titleRow = Math.floor(miniCrewCodeLogoLines.length / 2);
    expect(lines).toHaveLength(miniCrewCodeLogoLines.length + 2);
    expect(lines[titleRow]).toContain(miniCrewCodeLogoLines[titleRow]!);
    expect(lines.every((line) => line.length <= 40)).toBe(true);
  });
});

describe("MainViewport", () => {
  it("bottom-aligns a short transcript without embedding app chrome", () => {
    const state = createInitialState();
    state.blocks = [{ type: "assistant", text: "bottom-loaded response" }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 80, height: 24 } }).map(stripAnsi);
    const responseRow = lines.findIndex((line) => line.includes("bottom-loaded response"));

    expect(lines.join("\n")).not.toContain(compactCrewCodeLogoLines[0]!);
    expect(responseRow).toBeGreaterThan(19);
  });

  it("wraps long thinking text instead of truncating it", () => {
    const state = createInitialState();
    state.blocks = [{
      type: "thinking",
      text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omega"
    }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 34, height: 10 } });
    const plain = lines.map(stripAnsi);

    expect(plain.join("\n")).toContain("omega");
    expect(plain.join("\n")).not.toContain("…");
    expect(plain.join("\n")).toContain("THOUGHTS...");
    const thinkingIndex = plain.findIndex((line) => line.includes("THOUGHTS..."));
    expect(thinkingIndex).toBeGreaterThan(0);
    expect(plain[thinkingIndex - 1]?.trim()).toBe("");
    expect(plain.at(-1)?.trim()).toBe("");
    expect(plain.join("\n")).not.toContain("╭");
    expect(plain.join("\n")).not.toContain("╰");
    expect(plain.every((line) => line.length <= 34)).toBe(true);
  });

  it("adds padding around tool blocks", () => {
    const state = createInitialState();
    state.blocks = [{ type: "tool", name: "bash", status: "done", args: { command: "npm test" }, text: "all good" }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 42, height: 6 } });
    const plain = lines.map(stripAnsi);
    const toolIndex = plain.findIndex((line) => line.includes("TOOL: BASH"));

    expect(toolIndex).toBeGreaterThan(0);
    expect(plain[toolIndex - 1]?.trim()).toBe("");
    expect(plain.at(-1)?.trim()).toBe("");
    expect(plain.join("\n")).toContain("all good");
    expect(lines.join("\n")).toContain(`${fg(crewCoderTheme.muted)}${bold()}TOOL: BASH`);
    expect(lines.join("\n")).toContain(`${fg(crewCoderTheme.muted)}all good`);
    expect(plain.every((line) => line.length <= 42)).toBe(true);
  });

  it("uses extension tool display metadata for label, icon, and category", () => {
    const state = createInitialState();
    state.blocks = [{
      type: "tool",
      name: "extension_demo_audit",
      status: "done",
      args: { scope: "src" },
      text: "audit complete",
      metadata: { label: "Repo Audit", icon: "◎", category: "diagnostics" }
    }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 64, height: 8 } });
    const plain = lines.map(stripAnsi).join("\n");

    expect(plain).toContain("◎");
    expect(plain).toContain("TOOL: REPO AUDIT");
    expect(plain).toContain("diagnostics");
    expect(plain).toContain("audit complete");
  });

  it("renders matching extension tool blocks through custom renderer hooks", () => {
    const state = createInitialState();
    state.rendererHooks = [{
      extensionId: "demo",
      id: "audit-summary",
      title: "Audit Summary",
      target: "tool",
      match: { extensionId: "demo", toolId: "audit", renderer: "audit.summary" },
      template: "## {{metadata.title}}\nScope: **{{args.scope}}**\n{{text}}"
    }];
    state.blocks = [{
      type: "tool",
      name: "extension_demo_audit",
      status: "done",
      args: { scope: "src" },
      text: "3 issues found",
      metadata: { extensionId: "demo", toolId: "audit", renderer: "audit.summary", title: "Repo Audit" }
    }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 60, height: 10 } });
    const plain = lines.map(stripAnsi).join("\n");

    expect(plain).toContain("AUDIT SUMMARY");
    expect(plain).toContain("Repo Audit");
    expect(plain).toContain("Scope: src");
    expect(plain).toContain("3 issues found");
    expect(plain).not.toContain("TOOL:");
  });

  it("highlights tool detail segments with multiple colors", () => {
    const state = createInitialState();
    state.blocks = [{ type: "tool", name: "read", status: "done", args: { path: "src/components/MainViewport.ts", offset: 5, limit: 3 }, text: "" }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 80, height: 5 } });
    const plain = lines.map(stripAnsi).join("\n");
    const rendered = lines.join("\n");

    expect(plain).toContain("src/components/MainViewport.ts:5-7");
    expect(rendered).toContain(`${fg(crewCoderTheme.muted)}${bold()}src/components/MainViewport.ts`);
    expect(rendered).toContain(`${fg(crewCoderTheme.muted)}:5-7`);
  });

  it("renders assistant output throughput in the message header", () => {
    const state = createInitialState();
    state.blocks = [{ type: "assistant", text: "Fast reply", tokensPerSecond: 42.25 }];

    const plain = new MainViewport(state)
      .render({ theme: crewCoderTheme, size: { width: 48, height: 6 } })
      .map(stripAnsi)
      .join("\n");

    expect(plain).toContain("CREW CODER 42.3 tok/s");
  });

  it("renders assistant responses without a panel background or border", () => {
    const state = createInitialState();
    state.blocks = [{ type: "assistant", text: "Light mode reply" }];

    const rendered = new MainViewport(state).render({ theme: lightCrewCoderTheme, size: { width: 48, height: 6 } }).join("\n");
    const plain = stripAnsi(rendered);

    expect(rendered).not.toContain(bg(lightCrewCoderTheme.panel));
    expect(plain).toContain("CREW CODER");
    expect(plain).toContain("Light mode reply");
    expect(plain).not.toMatch(/[╭╮╰╯│]/u);
  });

  it("syntax-highlights plain tool output", () => {
    const state = createInitialState();
    state.blocks = [{ type: "tool", name: "read", status: "done", args: { path: "src/example.ts" }, text: "const name = 'CrewCoder' // ok" }];

    const rendered = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 80, height: 6 } }).join("\n");

    expect(rendered).toContain(`${fg(crewCoderTheme.warning)}const`);
    expect(rendered).toContain(`${fg(crewCoderTheme.success)}'CrewCoder'`);
    expect(rendered).toContain(`${fg(crewCoderTheme.muted)}${italic()}// ok`);
  });

  it("renders common markdown in assistant responses", () => {
    const state = createInitialState();
    state.blocks = [{ type: "assistant", text: "# Summary\n\n- **Done** item\n\n```ts\nconst ok = true;\n```" }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 48, height: 12 } });
    const plain = lines.map(stripAnsi).join("\n");

    expect(plain).toContain("Summary");
    expect(plain).toContain("• Done item");
    expect(plain).toContain("code · ts");
    expect(plain).toContain("const ok = true;");
    expect(lines.join("\n")).toContain(`${fg(crewCoderTheme.warning)}const`);
    expect(lines.join("\n")).toContain(`${fg(crewCoderTheme.accent3)}true`);
  });

  it("renders the working indicator on a single transcript line", () => {
    const state = createInitialState();
    state.blocks = [{ type: "assistant", text: "partial answer" }];
    state.running = true;

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 50, height: 20 } });
    const plain = lines.map(stripAnsi);
    const indicatorRows = plain.filter((line) => line.includes("AGENT IS WORKING"));

    expect(indicatorRows).toHaveLength(1);
    expect(indicatorRows[0]).toContain("Esc to abort");
    // The old 3x3 mosaic cost 8 transcript rows for one bit of state.
    const spinnerGlyphs = [...plain.join("\n")].filter((char) => SPINNER_FRAMES.includes(char as (typeof SPINNER_FRAMES)[number]));
    expect(spinnerGlyphs).toHaveLength(1);
  });

  it("shows a small scrollbar pill at the transcript scroll position", () => {
    const state = createInitialState();
    state.blocks = Array.from({ length: 14 }, (_, index) => ({ type: "assistant" as const, text: `answer ${index}` }));
    const viewport = new MainViewport(state);
    const ctx = { theme: crewCoderTheme, size: { width: 50, height: 8 } };

    const bottom = viewport.render(ctx);
    expect(bottom.slice(0, 6).every((line) => !stripAnsi(line).endsWith("▐"))).toBe(true);
    expect(bottom.slice(6).every((line) => stripAnsi(line).endsWith("▐"))).toBe(true);
    expect(bottom.join("\n")).toContain(`${fg(crewCoderTheme.muted)}▐`);

    state.viewportScroll = state.viewportMaxScroll;
    const top = viewport.render(ctx);
    expect(top.slice(0, 2).every((line) => stripAnsi(line).endsWith("▐"))).toBe(true);
    expect(top.slice(2).every((line) => !stripAnsi(line).endsWith("▐"))).toBe(true);
  });

  it("does not show a scrollbar pill when the transcript fits", () => {
    const state = createInitialState();
    state.blocks = [{ type: "assistant", text: "short answer" }];

    const rendered = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 50, height: 8 } });

    expect(rendered.every((line) => !stripAnsi(line).endsWith("▐"))).toBe(true);
  });

  it("holds scrolled-back content in place while the transcript grows", () => {
    const state = createInitialState();
    state.blocks = [{ type: "assistant", text: "first answer" }];
    const viewport = new MainViewport(state);
    const size = { width: 50, height: 8 };
    const renderPlain = () => viewport.render({ theme: crewCoderTheme, size }).map(stripAnsi).join("\n");

    for (let i = 0; i < 12; i++) state.blocks.push({ type: "assistant", text: `filler ${i}` });
    renderPlain();

    // Scroll back to the top of the transcript, then keep streaming.
    state.viewportScroll = state.viewportMaxScroll;
    const beforeGrowth = renderPlain();
    expect(beforeGrowth).toContain("first answer");

    state.running = true;
    for (let i = 0; i < 20; i++) state.blocks.push({ type: "assistant", text: `streamed ${i}` });
    expect(renderPlain()).toContain("first answer");

    // At the bottom the transcript still follows the stream.
    state.viewportScroll = 0;
    state.blocks.push({ type: "assistant", text: "latest answer" });
    expect(renderPlain()).toContain("latest answer");
  });

  it("keeps tracked file changes out of the transcript", () => {
    const state = createInitialState();
    state.blocks = [{ type: "assistant", text: "done" }];
    state.changedFiles = ["src/kept.ts"];

    const rendered = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 60, height: 10 } }).map(stripAnsi).join("\n");

    expect(rendered).not.toContain("FILE CHANGES");
    expect(rendered).not.toContain("src/kept.ts");
    expect(state.changedFiles).toEqual(["src/kept.ts"]);
  });

  it("renders a review summary block", () => {
    const state = createInitialState();
    state.blocks = [{
      type: "review_summary",
      summary: {
        branch: "feature/GH-123-review-ux",
        clean: false,
        changedFiles: ["crewcoder-tui/src/components/MainViewport.ts", "crewcoder-tui/src/state/tui-store.ts"],
        issueReferences: [{ id: "123", source: "branch", text: "GH-123", url: "https://github.com/acme/repo/issues/123" }]
      }
    }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 72, height: 14 } });
    const plain = lines.map(stripAnsi).join("\n");

    expect(plain).toContain("REVIEW SUMMARY");
    expect(plain).toContain("feature/GH-123-review-ux");
    expect(plain).toContain("dirty");
    expect(plain).toContain("2 changed files");
    expect(plain).toContain("crewcoder-tui/src/components/MainViewport.ts");
    expect(plain).toContain("GH-123 (branch)");
    expect(plain).toContain("https://github.com/acme/repo/issues/123");
  });

  it("renders running and completed crew agents", () => {
    const state = createInitialState();
    state.blocks = [{
      type: "crew",
      completed: false,
      workers: [
        { name: "reviewer", status: "completed", sessionId: "session_reviewer" },
        { name: "builder", status: "running", sessionId: "session_builder" },
        { name: "tester", status: "pending" }
      ]
    }];

    const plain = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 72, height: 12 } }).map(stripAnsi).join("\n");
    expect(plain).toContain("CREW RUNNING");
    expect(plain).toContain("3 agents · 1 active");
    expect(plain).toContain("reviewer");
    expect(plain).toContain("builder");
    expect(plain).toContain("tester");
  });

  it("renders a durable goal and its pending approval", () => {
    const state = createInitialState();
    state.blocks = [{
      type: "goal",
      goal: {
        id: "goal_2026_demo",
        objective: "Migrate the project until all contract tests pass",
        status: "awaiting_approval",
        provider: "codex",
        model: "gpt-test",
        cycle: 3,
        maxTurns: 200,
        checkModel: "gpt-5.6-luna",
        timeoutMinutes: 480,
        lastCheck: { verdict: "continue", reason: "Contract test output is still missing", model: "gpt-5.6-luna" },
        sessionId: "session_goal",
        pendingApproval: { toolName: "bash", reason: "Command requires review" }
      }
    }];

    const plain = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 72, height: 12 } }).map(stripAnsi).join("\n");
    expect(plain).toContain("GOAL AWAITING_APPROVAL");
    expect(plain).toContain("Migrate the project until all contract tests pass");
    expect(plain).toContain("maker codex/gpt-test");
    expect(plain).toContain("verifier codex/gpt-5.6-luna");
    expect(plain).toContain("cycle 3/200");
    expect(plain).toContain("Last check: continue");
    expect(plain).toContain("Approval required for bash");
    expect(plain).toContain("/goal approve");
  });

  it("renders a compaction progress meter", () => {
    const state = createInitialState();
    state.blocks = [{ type: "compaction", status: "running", percent: 35, message: "Summarizing older context…", originalMessageCount: 20, retainedMessageCount: 6 }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 52, height: 8 } });
    const plain = lines.map(stripAnsi).join("\n");

    expect(plain).toContain("COMPACTING SESSION");
    expect(plain).toContain("20 → 6 messages");
    expect(plain).toContain("35%");
    expect(plain).toContain("Summarizing older context");
  });

  it("renders an extension table component with aligned columns", () => {
    const state = createInitialState();
    state.blocks = [{
      type: "extension_ui",
      requestId: "req-1",
      extensionId: "demo",
      uiKind: "component",
      title: "Dependency report",
      status: "pending",
      component: {
        kind: "table",
        columns: [{ key: "pkg", label: "Package" }, { key: "version", label: "Version" }],
        rows: [
          { pkg: "vitest", version: "1.6.0" },
          { pkg: "typescript", version: "5.4.5" }
        ]
      }
    }];

    const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 60, height: 12 } });
    const plain = lines.map(stripAnsi);
    const joined = plain.join("\n");

    expect(joined).toContain("Package");
    expect(joined).toContain("Version");
    expect(joined).toContain("vitest");
    expect(joined).toContain("typescript");
    expect(joined).toContain("5.4.5");
    expect(joined).toContain("│");
    expect(joined).toContain("┼");
    expect(joined).not.toContain("2 rows · 2 columns");
    expect(plain.every((line) => line.length <= 60)).toBe(true);
  });

  it("caps large extension tables and reports remaining rows", () => {
    const state = createInitialState();
    const rows = Array.from({ length: 55 }, (_, index) => ({ id: String(index), name: `item-${index}` }));
    state.blocks = [{
      type: "extension_ui",
      requestId: "req-2",
      extensionId: "demo",
      uiKind: "component",
      title: "Large table",
      status: "pending",
      component: {
        kind: "table",
        columns: [{ key: "id", label: "ID" }, { key: "name", label: "Name" }],
        rows
      }
    }];

    const rendered = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 80, height: 200 } })
      .map(stripAnsi)
      .join("\n");

    expect(rendered).toContain("item-0");
    expect(rendered).toContain("item-49");
    expect(rendered).not.toContain("item-50");
    expect(rendered).toContain("+5 more rows");
  });

  it("copies selected viewport text on mouse release", () => {
    const state = createInitialState();
    state.blocks = [{ type: "assistant", text: "hello" }];
    const viewport = new MainViewport(state);
    const copied: string[] = [];

    viewport.render({ theme: crewCoderTheme, size: { width: 34, height: 6 } });
    viewport.handleMouse({ name: "mouse", sequence: "", ctrl: false, meta: false, shift: false, mouse: { x: 3, y: 5, button: 0, kind: "press" } }, 1, (text) => { copied.push(text); return true; });
    viewport.handleMouse({ name: "mouse", sequence: "", ctrl: false, meta: false, shift: false, mouse: { x: 12, y: 5, button: 32, kind: "drag" } }, 1, (text) => { copied.push(text); return true; });
    viewport.handleMouse({ name: "mouse", sequence: "", ctrl: false, meta: false, shift: false, mouse: { x: 12, y: 5, button: 0, kind: "release" } }, 1, (text) => { copied.push(text); return true; });

    const rerendered = viewport.render({ theme: crewCoderTheme, size: { width: 34, height: 6 } });

    expect(copied).toEqual(["CREW CODE"]);
    expect(rerendered.join("\n")).not.toContain(bg("#2f6f5a"));
  });

  it("renders a fallback error block when inline extension UI render throws", () => {
    const state = createInitialState();
    const base = {
      type: "extension_ui" as const,
      requestId: "req-boom",
      extensionId: "demo",
      uiKind: "component" as const,
      title: "Boom",
      status: "pending" as const
    };
    const throwing = new Proxy(base, {
      get(target, prop) {
        if (prop === "component") throw new Error("inline render exploded");
        return target[prop as keyof typeof target];
      }
    });
    state.blocks = [throwing];

    let result: string[] | undefined;
    expect(() => {
      result = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 60, height: 12 } });
    }).not.toThrow();

    const plain = result?.map(stripAnsi).join("\n") ?? "";
    expect(plain).toContain("extension UI error");
    expect(plain).toContain("demo");
    expect(plain).toContain("inline render exploded");
  });
});
