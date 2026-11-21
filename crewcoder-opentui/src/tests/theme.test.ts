import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { crewCoderTheme, lightCrewCoderTheme, loadCrewCoderTheme, MARKDOWN_KEYS, slateCrewCoderTheme, SYNTAX_KEYS } from "@onpoint-dev-tools/crewcoder-tui-core/theme/crewcoder-theme";
import { describe, expect, it } from "vitest";
import { markdownStyles, markupStyles } from "../markdown-style.js";
import { bodyColor, mixHex, slateAppTheme, slateTheme, toAppTheme, toneColor } from "../theme.js";

const EMBER = fileURLToPath(new URL("../../examples/themes/ember.json", import.meta.url));
/** OpenTUI's bundled markdown queries (the workspace hoists @opentui/core to the repo root). */
const OPENTUI_ASSETS = fileURLToPath(new URL("../../../node_modules/@opentui/core/assets/", import.meta.url));

/** WCAG contrast ratio of two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((index) => {
      const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe("slate (default theme)", () => {
  it("keeps the slate palette that was hardcoded before themes", () => {
    expect(slateTheme.name).toBe("slate");
    expect(slateTheme.colors).toMatchObject({
      background: "#101216", foreground: "#d3d6dc", primary: "#a7adb7", primaryForeground: "#101216",
      secondary: "#292d34", accent: "#c0c5ce", success: "#aab8ad", warning: "#c4b99f", error: "#c28f91",
      info: "#a7adb7", muted: "#181b20", mutedForeground: "#858c97", border: "#3b414b", focusRing: "#a7adb7",
      selection: "#343942"
    });
    expect(slateTheme.border).toEqual({ color: "#3b414b", focusColor: "#a7adb7", style: "rounded" });
    expect(slateAppTheme.diff).toMatchObject({ addedBg: "#18241c", removedBg: "#2a1a1c", lineNumberBg: "#15181d" });
    expect(slateAppTheme.syntax).toMatchObject({ keyword: "#b7a6cf", string: "#a9bf9c", comment: "#6f7682" });
  });

  it("keeps the markdown element colors replies had before they were themeable", () => {
    const styles = markdownStyles(slateTheme, { base: "#d3d6dc", heading: slateAppTheme.markdown.heading }, slateAppTheme.syntax, slateAppTheme.markdown);
    expect(styles["markup.heading.1"]).toEqual({ fg: "#a7adb7", bold: true });
    expect(styles["markup.strong"]).toEqual({ fg: "#d3d6dc", bold: true });
    expect(styles["markup.italic"]).toEqual({ fg: "#d3d6dc", italic: true });
    expect(styles["markup.raw"]).toEqual({ fg: "#c0c5ce" });
    expect(styles["markup.link"]).toEqual({ fg: "#a7adb7", underline: true });
    expect(styles["markup.link.url"]).toEqual({ fg: "#858c97" });
    expect(styles["markup.list"]).toEqual({ fg: "#858c97" });
    expect(styles["markup.quote"]).toEqual({ fg: "#858c97" });
    expect(styles["conceal"]).toEqual({ fg: "#858c97" });
    expect(styles["default"]).toEqual({ fg: "#d3d6dc" });
  });

  it("draws reasoning in the muted text color", () => {
    expect(toneColor(slateTheme, "thinking")).toBe("#858c97");
    expect(bodyColor(slateTheme, "thinking")).toBe("#858c97");
    expect(bodyColor(slateTheme, "assistant")).toBe("#d3d6dc");
  });
});

describe("toAppTheme", () => {
  it("maps the shared tokens onto termcn tokens, diff colors, and syntax", () => {
    const gotham = toAppTheme(crewCoderTheme);
    expect(gotham.ui.name).toBe("dark");
    expect(gotham.ui.colors).toMatchObject({
      background: "#0c1014", foreground: "#c3e6e4", primary: "#33859e", error: "#c23127",
      mutedForeground: "#6f9e9b", muted: "#0d161d", border: "#195466", selection: "#0a3749",
      primaryForeground: "#0c1014", errorForeground: "#0c1014"
    });
    expect(gotham.diff).toMatchObject({ addedBg: "#123528", removedBg: "#3a1512", lineNumberBg: "#11151c" });
    expect(gotham.syntax).toBe(crewCoderTheme.syntax);
    expect(toAppTheme(lightCrewCoderTheme).ui.colors.background).toBe("#eef4f3");
  });

  it("lifts diff gutters slightly from the row tint", () => {
    const { diff } = slateAppTheme;
    expect(diff.addedLineNumberBg).toBe(mixHex("#18241c", "#d3d6dc", 0.03));
    expect(diff.addedLineNumberBg).not.toBe(diff.addedBg);
  });
});

describe("markupStyles", () => {
  it("styles every full markup capture the markdown grammar emits", () => {
    // SyntaxStyle falls back only to the first segment (`markup`), which has no style.
    const grammar = ["markdown", "markdown_inline"]
      .map((name) => fs.readFileSync(`${OPENTUI_ASSETS}${name}/highlights.scm`, "utf8"))
      .join("\n");
    const captures = new Set([...grammar.matchAll(/@(markup(?:\.[a-z_]+)+)/g)].map((match) => match[1]!));
    const styles = markupStyles(slateAppTheme.markdown, "#ffffff", "#000000");
    expect(captures.size).toBeGreaterThan(5);
    for (const capture of captures) {
      const covered = capture in styles || /^markup\.heading\.[1-6]$/.test(capture);
      expect(covered, capture).toBe(true);
    }
  });
});

describe("example theme (examples/themes/ember.json)", () => {
  it("loads through the shared loader and sets every token itself", () => {
    const raw = JSON.parse(fs.readFileSync(EMBER, "utf8")) as { colors: object; syntax: object; markdown: object };
    expect(Object.keys(raw.syntax).sort()).toEqual([...SYNTAX_KEYS].sort());
    expect(Object.keys(raw.markdown).sort()).toEqual([...MARKDOWN_KEYS].sort());
    expect(Object.keys(raw.colors)).toHaveLength(Object.keys(slateCrewCoderTheme).length - 3);
    const theme = loadCrewCoderTheme(EMBER);
    expect(theme.name).toBe("ember");
    expect(theme.background).toBe("#16130f");
    expect(theme.syntax.keyword).toBe("#e07a5f");
    expect(theme.markdown.heading).toBe("#e0a458");
  });

  it("keeps text readable on its background", () => {
    const theme = loadCrewCoderTheme(EMBER);
    expect(contrast(theme.text, theme.background)).toBeGreaterThanOrEqual(7);
    for (const color of [theme.muted, ...Object.values(theme.syntax), ...Object.values(theme.markdown)]) {
      expect(contrast(color, theme.background)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("mixHex", () => {
  it("interpolates each channel", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ff8000", 0.5)).toBe("#804000");
  });
});
