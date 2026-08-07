import { describe, expect, it, vi } from "vitest";
import { PickerOverlay } from "../components/PickerOverlay.js";
import { CommandPalette, type CommandPaletteItem } from "../components/CommandPalette.js";
import { ApprovalOverlay } from "../components/ApprovalOverlay.js";
import { crewCoderTheme } from "../theme/theme.js";

const ctx = { theme: crewCoderTheme, size: { width: 60, height: 12 } };
const click = (y: number) => ({ name: "mouse", sequence: "", ctrl: false, meta: false, shift: false, mouse: { x: 4, y, button: 0, kind: "press" as const } });

describe("mouse selection", () => {
  it("selects generic picker rows with a click", () => {
    const selected = vi.fn();
    const picker = new PickerOverlay("Pick", [
      { label: "one", value: "1" }, { label: "two", value: "2" }, { label: "three", value: "3" }
    ], selected);
    picker.render(ctx);
    picker.handleInput(click(4)); // title+blank, then second option
    expect(selected).toHaveBeenCalledWith({ label: "two", value: "2" });
  });

  it("selects fuzzy palette rows while skipping category headers", () => {
    const selected = vi.fn();
    const palette = new CommandPalette(selected);
    const items: CommandPaletteItem[] = [
      { id: "one", category: "Modes", label: "auto", description: "auto", action: { type: "command", command: "/mode auto" } },
      { id: "two", category: "Modes", label: "plugin", description: "plugin", action: { type: "command", command: "/mode plugin" } }
    ];
    palette.setItems(items);
    palette.render({ ...ctx, size: { width: 60, height: 14 } });
    palette.handleInput(click(7)); // title, blank, search, blank, header, first, second
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "two" }));
  });

  it("clicks approval actions", () => {
    const resolved = vi.fn();
    const overlay = new ApprovalOverlay({ type: "approval", text: "Allow?", status: "pending" }, resolved);
    const lines = overlay.render({ ...ctx, size: { width: 60, height: 16 } });
    const deny = lines.findIndex((line) => line.includes("Deny"));
    overlay.handleInput(click(deny + 1));
    expect(resolved).toHaveBeenCalledWith(false);
  });
});
