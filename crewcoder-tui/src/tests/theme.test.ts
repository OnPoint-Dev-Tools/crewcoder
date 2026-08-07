import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crewCoderTheme, lightCrewCoderTheme, loadCrewCoderTheme, loadCrewCoderThemeFromPath } from "../theme/theme.js";

describe("theme loading", () => {
  it("loads built-in themes by name", () => {
    expect(loadCrewCoderTheme("dark")).toEqual(crewCoderTheme);
    expect(loadCrewCoderTheme("light")).toEqual(lightCrewCoderTheme);
  });

  it("loads custom JSON themes with vars and 256-color values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-theme-"));
    const file = path.join(dir, "custom.json");
    fs.writeFileSync(file, JSON.stringify({
      name: "custom",
      vars: {
        ink: "#abcdef",
        panel: 236
      },
      colors: {
        text: "ink",
        panel: "panel",
        accent: "#123456"
      }
    }));

    const theme = loadCrewCoderThemeFromPath(file);

    expect(theme.name).toBe("custom");
    expect(theme.text).toBe("#abcdef");
    expect(theme.panel).toBe("#303030");
    expect(theme.accent).toBe("#123456");
    expect(theme.background).toBe(crewCoderTheme.background);
  });
});
