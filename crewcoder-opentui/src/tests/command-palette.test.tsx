import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { CommandPalette } from "../components/ui/command-palette.js";
import { pickerEntries, pickerHeight, pickerView, type PaletteCommand, type PickerView } from "../palette-model.js";
import { ThemeProvider } from "../providers/theme-provider.js";
import { slateTheme } from "../theme.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
let active: Setup | undefined;

afterEach(async () => {
  await active?.dispose();
  active = undefined;
});

const COMMANDS: readonly PaletteCommand[] = [
  { id: "/new", label: "/new", description: "Start a fresh session", group: "Session" },
  { id: "/model", label: "/model", description: "Pick a model", group: "Config" },
  { id: "/stop", label: "/stop", description: "Stop the active run", group: "Session" },
  { id: "/help", label: "/help", description: "Show help" }
];

const MODELS: readonly PaletteCommand[] = Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, label: `model-${index}` }));

async function render(view: PickerView, title?: string): Promise<string[]> {
  active = await testRender(
    <ThemeProvider theme={slateTheme}>
      <CommandPalette view={view} query="" title={title} />
    </ThemeProvider>,
    { width: 60, height: 40 }
  );
  await active.renderOnce();
  return active.captureCharFrame().split("\n");
}

/** Rows between the palette's rounded top and bottom borders, inclusive. */
function borderedHeight(lines: string[]): number {
  const top = lines.findIndex((line) => line.includes("╭"));
  const bottom = lines.length - 1 - [...lines].reverse().findIndex((line) => line.includes("╰"));
  return bottom - top + 1;
}

describe("pickerHeight", () => {
  it.each([
    ["interleaved groups plus an ungrouped item", COMMANDS, ""],
    ["a single group", COMMANDS, "stop"],
    ["no matches", COMMANDS, "zzzz"],
    ["a scrolled long list", MODELS, ""]
  ])("matches the rendered palette for %s", async (_label, items, query) => {
    const view = pickerView(items, query, 0, 8);
    expect(borderedHeight(await render(view, "Title"))).toBe(pickerHeight(view));
  });
});

describe("pickerView", () => {
  it("orders entries by group so the cursor indexes the drawn order", async () => {
    expect(pickerEntries(COMMANDS, "").map((item) => item.id)).toEqual(["/new", "/stop", "/model", "/help"]);
    const lines = await render(pickerView(COMMANDS, "", 1, 12));
    const selected = lines.findIndex((line) => line.includes("/stop"));
    expect(selected).toBeGreaterThan(lines.findIndex((line) => line.includes("/new")));
    expect(selected).toBeLessThan(lines.findIndex((line) => line.includes("/model")));
  });

  it("scrolls a long list to keep the selected item visible and reports the position", async () => {
    const view = pickerView(MODELS, "", 25, 8);
    expect(view.rows).toHaveLength(8);
    expect(view.rows.some((row) => row.kind === "item" && row.index === 25)).toBe(true);
    const frame = (await render(view)).join("\n");
    expect(frame).toContain("model-25");
    expect(frame).not.toContain("model-0");
    expect(frame).toContain("26/30");
  });

  it("ranks label matches above description-only matches", () => {
    expect(pickerEntries(COMMANDS, "model").map((item) => item.id)[0]).toBe("/model");
  });
});
