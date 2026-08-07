import { describe, expect, it } from "vitest";
import { ExtensionUiOverlay } from "../components/ExtensionUiOverlay.js";
import type { TuiEventBlock } from "../state/tui-store.js";
import { crewCoderTheme } from "../theme/theme.js";
import { stripAnsi } from "../tui/ansi.js";
import type { KeyEvent } from "../tui/component.js";

type ExtensionUiBlock = Extract<TuiEventBlock, { type: "extension_ui" }>;

function key(name: string, sequence = ""): KeyEvent {
  return { name, sequence, ctrl: false, meta: false, shift: false };
}

function block(partial: Partial<ExtensionUiBlock> & Pick<ExtensionUiBlock, "uiKind">): ExtensionUiBlock {
  return {
    type: "extension_ui",
    requestId: "extui_1",
    extensionId: "demo",
    title: "Question?",
    status: "pending",
    ...partial
  };
}

describe("ExtensionUiOverlay", () => {
  it("resolves a confirm request true on 'y' and false on 'n'", () => {
    const yes: Array<string | boolean | null> = [];
    new ExtensionUiOverlay(block({ uiKind: "confirm" }), (v) => yes.push(v)).handleInput(key("y"));
    expect(yes).toEqual([true]);

    const no: Array<string | boolean | null> = [];
    new ExtensionUiOverlay(block({ uiKind: "confirm" }), (v) => no.push(v)).handleInput(key("n"));
    expect(no).toEqual([false]);
  });

  it("resolves a confirm request via arrow navigation and enter", () => {
    const resolved: Array<string | boolean | null> = [];
    const overlay = new ExtensionUiOverlay(block({ uiKind: "confirm" }), (v) => resolved.push(v));
    overlay.handleInput(key("down")); // move to "No"
    overlay.handleInput(key("return"));
    expect(resolved).toEqual([false]);
  });

  it("resolves a select request to the highlighted option value", () => {
    const resolved: Array<string | boolean | null> = [];
    const overlay = new ExtensionUiOverlay(
      block({ uiKind: "select", options: [{ label: "Staging", value: "staging" }, { label: "Prod", value: "prod" }] }),
      (v) => resolved.push(v)
    );
    overlay.handleInput(key("down"));
    overlay.handleInput(key("return"));
    expect(resolved).toEqual(["prod"]);

    const plain = overlay.render({ theme: crewCoderTheme, size: { width: 50, height: 14 } }).map(stripAnsi);
    expect(plain.join("\n")).toContain("Staging");
    expect(plain.join("\n")).toContain("Prod");
  });

  it("renders a declarative component and resolves the selected action", () => {
    const resolved: Array<string | boolean | null> = [];
    const overlay = new ExtensionUiOverlay(
      block({
        uiKind: "component",
        title: "Repo Status",
        component: { kind: "markdown", text: "## Ready\nAll checks passed." },
        actions: [{ id: "apply", label: "Apply" }, { id: "close", label: "Close" }]
      }),
      (v) => resolved.push(v)
    );

    const plain = overlay.render({ theme: crewCoderTheme, size: { width: 50, height: 16 } }).map(stripAnsi).join("\n");
    expect(plain).toContain("Ready");
    expect(plain).toContain("All checks passed.");
    expect(plain).toContain("Apply");

    overlay.handleInput(key("down"));
    overlay.handleInput(key("return"));
    expect(resolved).toEqual(["close"]);
  });

  it("collects typed characters for an input request and submits on enter", () => {
    const resolved: Array<string | boolean | null> = [];
    const overlay = new ExtensionUiOverlay(block({ uiKind: "input", placeholder: "branch" }), (v) => resolved.push(v));
    overlay.handleInput(key("d", "d"));
    overlay.handleInput(key("e", "e"));
    overlay.handleInput(key("v", "v"));
    overlay.handleInput(key("x", "x"));
    overlay.handleInput(key("backspace"));
    overlay.handleInput(key("return"));
    expect(resolved).toEqual(["dev"]);
  });

  it("pre-fills an input request with the default value", () => {
    const resolved: Array<string | boolean | null> = [];
    const overlay = new ExtensionUiOverlay(block({ uiKind: "input", defaultValue: "main" }), (v) => resolved.push(v));
    overlay.handleInput(key("return"));
    expect(resolved).toEqual(["main"]);
  });

  it("wraps a long question and long option descriptions instead of truncating them", () => {
    const title = "Plain Up/Down never reach the viewport today because the composer claims them for message-history recall. Which behavior do you want?";
    const description = "No change to the documented arrow order. With the scroll drift fixed, scrolled-back content stays put on its own.";
    const overlay = new ExtensionUiOverlay(
      block({
        uiKind: "select",
        title,
        options: [
          { label: "Keep recall, scroll on wheel/PgUp/PgDn", value: "keep", description },
          { label: "Arrows scroll while the agent is running", value: "scroll", description: "During an active run, Up/Down scroll the transcript." }
        ]
      }),
      () => undefined
    );

    const width = 60;
    const rendered = overlay.render({ theme: crewCoderTheme, size: { width, height: overlay.desiredHeight(width) } });
    const plain = rendered.map(stripAnsi);

    expect(plain.every((line) => line.length === width)).toBe(true);
    expect(plain.some((line) => line.includes("…"))).toBe(false);
    // Collapsing the wrapped rows must reproduce the full question and description.
    const collapsed = plain.map((line) => line.trim()).join(" ").replace(/\s+/g, " ");
    expect(collapsed).toContain(title);
    expect(collapsed).toContain(description);
    // Descriptions sit indented beneath their label rather than trailing it.
    expect(plain.some((line) => line.startsWith("● Keep recall, scroll on wheel/PgUp/PgDn"))).toBe(true);
    expect(plain.some((line) => line.startsWith("    No change to the documented"))).toBe(true);
  });

  it("selects an option when a wrapped description row is clicked", () => {
    const resolved: Array<string | boolean | null> = [];
    const overlay = new ExtensionUiOverlay(
      block({
        uiKind: "select",
        options: [
          { label: "First", value: "first", description: "A description long enough to wrap across more than one rendered row in the modal." },
          { label: "Second", value: "second", description: "Another option." }
        ]
      }),
      (v) => resolved.push(v)
    );

    const width = 40;
    const plain = overlay.render({ theme: crewCoderTheme, size: { width, height: overlay.desiredHeight(width) } }).map(stripAnsi);
    const secondRow = plain.findIndex((line) => line.trim() === "Another option.");
    expect(secondRow).toBeGreaterThan(0);

    // Component-local mouse coordinates are 1-based.
    overlay.handleInput({ ...key("mouse"), mouse: { x: 5, y: secondRow + 1, button: 0, kind: "press" } });
    expect(resolved).toEqual(["second"]);
  });

  it("keeps the selected option visible when the list is taller than the modal", () => {
    const options = Array.from({ length: 8 }, (_, index) => ({
      label: `Option ${index}`,
      value: `v${index}`,
      description: `Rationale for option ${index} that is long enough to wrap onto a second rendered row.`
    }));
    const overlay = new ExtensionUiOverlay(block({ uiKind: "select", options }), () => undefined);

    for (let i = 0; i < 7; i++) overlay.handleInput(key("down"));
    const plain = overlay.render({ theme: crewCoderTheme, size: { width: 44, height: 14 } }).map(stripAnsi);

    expect(plain.some((line) => line.startsWith("● Option 7"))).toBe(true);
    expect(plain.some((line) => line.includes("Option 0"))).toBe(false);
  });

  it("grows desiredHeight for wrapped content and shrinks at wider widths", () => {
    const overlay = new ExtensionUiOverlay(
      block({
        uiKind: "select",
        title: "A question that is quite long and will certainly need more than one rendered row at a narrow width.",
        options: [{ label: "Only option", value: "only", description: "With a rationale attached that also wraps." }]
      }),
      () => undefined
    );

    expect(overlay.desiredHeight(30)).toBeGreaterThan(overlay.desiredHeight(100));
    expect(overlay.desiredHeight(100)).toBeGreaterThan(6);
  });

  it("renders a fallback error block when render() throws", () => {
    const throwing = new Proxy(block({ uiKind: "confirm" }), {
      get(target, prop) {
        if (prop === "title") throw new Error("render exploded");
        return target[prop as keyof ExtensionUiBlock];
      }
    });
    const overlay = new ExtensionUiOverlay(throwing, () => undefined);

    let result: string[] | undefined;
    expect(() => {
      result = overlay.render({ theme: crewCoderTheme, size: { width: 50, height: 14 } });
    }).not.toThrow();

    const plain = result?.map(stripAnsi).join("\n") ?? "";
    expect(plain).toContain("extension UI error");
    expect(plain).toContain("demo");
    expect(plain).toContain("render exploded");
  });

  it("returns handled input and does not throw when handleInput() throws", () => {
    const throwing = new Proxy(block({ uiKind: "confirm" }), {
      get(target, prop) {
        if (prop === "uiKind") throw new Error("input exploded");
        return target[prop as keyof ExtensionUiBlock];
      }
    });
    const overlay = new ExtensionUiOverlay(throwing, () => undefined);

    let handled: boolean | undefined;
    expect(() => {
      handled = overlay.handleInput(key("return"));
    }).not.toThrow();

    expect(handled).toBe(true);
  });
});
