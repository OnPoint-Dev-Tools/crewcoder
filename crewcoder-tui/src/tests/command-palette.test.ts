import { describe, expect, it, vi } from "vitest";
import { CommandPalette, builtinPaletteItems, fuzzyScore, type CommandPaletteItem } from "../components/CommandPalette.js";
import { crewCoderTheme } from "../theme/theme.js";
import { stripAnsi } from "../tui/ansi.js";

const ctx = { theme: crewCoderTheme, size: { width: 90, height: 20 } };
const key = (name: string, sequence = "") => ({ name, sequence, ctrl: false, meta: false, shift: false });

describe("CommandPalette", () => {
  it("includes session browsing under both command names", () => {
    const items = builtinPaletteItems();
    expect(items).toContainEqual(expect.objectContaining({ label: "/sessions" }));
    expect(items).toContainEqual(expect.objectContaining({ label: "/resume", category: "Session" }));
  });

  it("includes the durable goal command", () => {
    expect(builtinPaletteItems()).toContainEqual(expect.objectContaining({ label: "/goal" }));
  });

  it("separates settings from operational commands", () => {
    const items = builtinPaletteItems();
    expect(items).toContainEqual(expect.objectContaining({ label: "/provider", category: "Settings" }));
    expect(items).toContainEqual(expect.objectContaining({ label: "/thinking", category: "Settings" }));
    expect(items).toContainEqual(expect.objectContaining({ label: "/set-budget", category: "Settings" }));
    expect(items).toContainEqual(expect.objectContaining({ label: "/file-changes", category: "Settings" }));
    expect(items).toContainEqual(expect.objectContaining({ label: "/add-dir", category: "Settings" }));
    expect(items).toContainEqual(expect.objectContaining({ label: "/new", category: "Session" }));
    expect(items).toContainEqual(expect.objectContaining({ label: "/commands", category: "Content & Extensions" }));
  });

  it("hides CrewCode commands in standalone and shows them in crewcode profile", () => {
    expect(builtinPaletteItems("standalone")).not.toContainEqual(expect.objectContaining({ label: "/plugins" }));
    expect(builtinPaletteItems("crewcode")).toContainEqual(expect.objectContaining({ label: "/plugins" }));
    expect(builtinPaletteItems("standalone")).toContainEqual(expect.objectContaining({ label: "/profile" }));
  });

  it("fuzzy matches non-contiguous command text", () => {
    expect(fuzzyScore("rvsm", "/review-summary show git branch")).toBeGreaterThanOrEqual(0);
    expect(fuzzyScore("zzzz", "/review-summary show git branch")).toBe(-1);
  });

  it("searches commands, workers, modes, extensions, and sessions", () => {
    const items: CommandPaletteItem[] = [
      ...builtinPaletteItems(),
      { id: "mode:plugin", category: "Modes", label: "plugin", description: "Plugin mode", action: { type: "command", command: "/mode plugin" } },
      { id: "worker:builder", category: "Workers", label: "Builder", description: "Saved worker", action: { type: "command", command: "/worker Builder" } },
      { id: "extension:lint", category: "Extensions", label: "Lint Guard", description: "lint-guard", action: { type: "extension", extensionId: "lint-guard" } },
      { id: "session:one", category: "Sessions", label: "Fix flaky checkout", description: "session_one", action: { type: "session", sessionId: "session_one" } }
    ];
    const palette = new CommandPalette();
    palette.setItems(items);
    palette.setQuery("/bldr");
    expect(palette.render(ctx).map(stripAnsi).join("\n")).toContain("Builder");
    palette.setQuery("/flky");
    expect(palette.render(ctx).map(stripAnsi).join("\n")).toContain("Fix flaky checkout");
    palette.setQuery("/lint grd");
    expect(palette.render(ctx).map(stripAnsi).join("\n")).toContain("Lint Guard");
  });

  it("shows and selects the strongest match before weaker category matches", () => {
    const selected = vi.fn();
    const palette = new CommandPalette(selected);
    palette.setItems([
      ...builtinPaletteItems(),
      { id: "mode:general", category: "Modes", label: "general", description: "General coding agent mode", action: { type: "command", command: "/mode general" } }
    ]);
    palette.setQuery("/general");

    const rendered = palette.render({ ...ctx, size: { width: 90, height: 10 } }).map(stripAnsi).join("\n");
    expect(rendered).toContain("General coding agent mode");
    palette.handleInput(key("return", "\r"));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "mode:general" }));
  });

  it("supports hover highlighting and wheel scrolling", () => {
    const selected = vi.fn();
    const palette = new CommandPalette(selected);
    palette.setItems(Array.from({ length: 12 }, (_, index) => ({
      id: `mode:${index}`, category: "Modes" as const, label: `mode-${index}`, description: `Mode ${index}`,
      action: { type: "command" as const, command: `/mode mode-${index}` }
    })));
    palette.render({ ...ctx, size: { width: 90, height: 12 } });
    palette.handleInput({ ...key("mouse"), mouse: { x: 4, y: 7, button: 35, kind: "hover" } });
    palette.handleInput({ ...key("wheelup"), mouse: { x: 4, y: 7, button: 64, kind: "wheel" } });
    palette.handleInput(key("return", "\r"));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "mode:0" }));
    selected.mockClear();
    palette.handleInput({ ...key("wheeldown"), mouse: { x: 4, y: 7, button: 65, kind: "wheel" } });
    palette.handleInput(key("return", "\r"));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "mode:3" }));
  });

  it("accepts typing while open and selects the filtered item", () => {
    const selected = vi.fn();
    const changed = vi.fn();
    const palette = new CommandPalette(selected, changed);
    palette.setItems([
      { id: "worker:builder", category: "Workers", label: "Builder", description: "Saved worker", action: { type: "command", command: "/worker Builder" } }
    ]);
    for (const char of "bldr") palette.handleInput(key(char, char));
    expect(changed).toHaveBeenLastCalledWith("/bldr");
    palette.handleInput(key("return", "\r"));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "worker:builder" }));
  });
});
