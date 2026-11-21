import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  crewCoderTheme,
  lightCrewCoderTheme,
  listBuiltinThemeNames,
  listThemeFiles,
  loadCrewCoderTheme,
  loadCrewCoderThemeFromPath,
  MARKDOWN_KEYS,
  slateCrewCoderTheme,
  SYNTAX_KEYS
} from "../theme/crewcoder-theme.js";

let dir: string;
const savedHome = process.env.CREWCODER_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-theme-"));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = savedHome;
});

function writeTheme(name: string, body: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

describe("built-in themes", () => {
  it("resolves every built-in name, including slate", () => {
    expect(listBuiltinThemeNames()).toEqual(["dark", "crewcoder", "light", "slate"]);
    expect(loadCrewCoderTheme("dark")).toBe(crewCoderTheme);
    expect(loadCrewCoderTheme("crewcoder")).toBe(crewCoderTheme);
    expect(loadCrewCoderTheme("light")).toBe(lightCrewCoderTheme);
    expect(loadCrewCoderTheme(" slate ")).toBe(slateCrewCoderTheme);
  });

  it("keeps Gotham's required base colors in dark", () => {
    expect(crewCoderTheme.background).toBe("#0c1014");
    expect(crewCoderTheme.border).toBe("#195466");
    expect(crewCoderTheme.primary).toBe("#33859e");
  });

  it("gives every built-in a full syntax and markdown palette", () => {
    for (const theme of [crewCoderTheme, lightCrewCoderTheme, slateCrewCoderTheme]) {
      expect(Object.keys(theme.syntax).sort()).toEqual([...SYNTAX_KEYS].sort());
      expect(Object.keys(theme.markdown).sort()).toEqual([...MARKDOWN_KEYS].sort());
      for (const color of [...Object.values(theme.syntax), ...Object.values(theme.markdown)]) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("uses the caller's fallback when no theme is selected", () => {
    expect(loadCrewCoderTheme(undefined)).toBe(crewCoderTheme);
    expect(loadCrewCoderTheme("  ", { fallback: slateCrewCoderTheme })).toBe(slateCrewCoderTheme);
  });

  it("never treats prototype keys as built-in names", () => {
    expect(() => loadCrewCoderTheme("constructor", { themesDir: dir })).toThrow("Theme not found: constructor");
  });
});

describe("theme files", () => {
  it("resolves syntax colors from hex, vars, and 256-color indexes over the base", () => {
    const theme = loadCrewCoderThemeFromPath(writeTheme("t.json", {
      name: "mine",
      vars: { violet: "#AA88FF", grey: 245 },
      syntax: { keyword: "violet", comment: "grey", string: "#112233" }
    }));
    expect(theme.syntax.keyword).toBe("#aa88ff");
    expect(theme.syntax.comment).toBe("#8a8a8a");
    expect(theme.syntax.string).toBe("#112233");
    expect(theme.syntax.function).toBe(crewCoderTheme.syntax.function);
    expect(theme.background).toBe(crewCoderTheme.background);
  });

  it("resolves markdown colors over the base", () => {
    const theme = loadCrewCoderThemeFromPath(writeTheme("t.json", {
      name: "mine",
      extends: "light",
      vars: { ink: "#204060" },
      markdown: { heading: "ink", code: 130 }
    }));
    expect(theme.markdown.heading).toBe("#204060");
    expect(theme.markdown.code).toBe("#af5f00");
    expect(theme.markdown.link).toBe(lightCrewCoderTheme.markdown.link);
  });

  it("merges over the theme named in extends", () => {
    const theme = loadCrewCoderThemeFromPath(writeTheme("t.json", { name: "mine", extends: "slate", colors: { text: "#ffffff" } }));
    expect(theme.name).toBe("mine");
    expect(theme.text).toBe("#ffffff");
    expect(theme.background).toBe(slateCrewCoderTheme.background);
    expect(theme.syntax).toEqual(slateCrewCoderTheme.syntax);
    expect(theme.markdown).toEqual(slateCrewCoderTheme.markdown);
  });

  it("loads a named theme from $CREWCODER_HOME/themes", () => {
    fs.mkdirSync(path.join(dir, "themes"));
    fs.writeFileSync(path.join(dir, "themes", "night.json"), JSON.stringify({ name: "night", colors: { accent: "#123456" } }));
    process.env.CREWCODER_HOME = dir;
    expect(loadCrewCoderTheme("night").accent).toBe("#123456");
  });

  it.each([
    ["not json", "{", /Invalid theme file .*t\.json: /],
    ["an unknown syntax key", { name: "x", syntax: { variable: "#ffffff" } }, /syntax: Unrecognized key/],
    ["an unknown color key", { name: "x", colors: { fg: "#ffffff" } }, /colors: Unrecognized key/],
    ["an unknown markdown key", { name: "x", markdown: { table: "#ffffff" } }, /markdown: Unrecognized key/],
    ["a bad hex color", { name: "x", syntax: { keyword: "#fff" } }, /Invalid theme hex color: #fff/],
    ["an unknown variable", { name: "x", syntax: { keyword: "nope" } }, /Unknown theme variable: nope/],
    ["a circular variable", { name: "x", vars: { a: "b", b: "a" }, colors: { text: "a" } }, /Circular theme variable reference/],
    ["an unknown extends", { name: "x", extends: "neon" }, /extends: unknown built-in theme neon/],
    ["a missing name", { colors: {} }, /name: Required/]
  ])("rejects %s with the file path", (_label, body, message) => {
    const file = writeTheme("t.json", body);
    expect(() => loadCrewCoderThemeFromPath(file)).toThrow(message);
    expect(() => loadCrewCoderThemeFromPath(file)).toThrow(file);
  });

  it("searches extra directories after the themes directory", () => {
    const user = path.join(dir, "user");
    const extra = path.join(dir, "extra");
    fs.mkdirSync(user);
    fs.mkdirSync(extra);
    fs.writeFileSync(path.join(extra, "shared.json"), JSON.stringify({ name: "from extra" }));
    expect(loadCrewCoderTheme("shared", { themesDir: user, extraDirs: [extra] }).name).toBe("from extra");
    fs.writeFileSync(path.join(user, "shared.json"), JSON.stringify({ name: "from user" }));
    expect(loadCrewCoderTheme("shared", { themesDir: user, extraDirs: [extra] }).name).toBe("from user");
  });

  it("names the built-ins when a theme is not found", () => {
    expect(() => loadCrewCoderTheme("missing", { themesDir: dir })).toThrow("Theme not found: missing (built-in themes: dark, crewcoder, light, slate)");
  });
});

describe("listThemeFiles", () => {
  it("lists every json theme by name, loaded or with the reason it is unusable", () => {
    const user = path.join(dir, "user");
    const extra = path.join(dir, "extra");
    fs.mkdirSync(user);
    fs.mkdirSync(extra);
    fs.writeFileSync(path.join(user, "night.json"), JSON.stringify({ name: "Night", extends: "slate" }));
    fs.writeFileSync(path.join(user, "broken.json"), "{");
    fs.writeFileSync(path.join(user, "dark.json"), JSON.stringify({ name: "my dark" }));
    fs.writeFileSync(path.join(user, "notes.txt"), "not a theme");
    fs.writeFileSync(path.join(extra, "night.json"), JSON.stringify({ name: "shadowed by user" }));
    fs.writeFileSync(path.join(extra, "aurora.json"), JSON.stringify({ name: "Aurora" }));
    const entries = listThemeFiles([user, extra, path.join(dir, "missing")]);
    expect(entries.map((entry) => [entry.name, entry.dir === user ? "user" : "extra"])).toEqual([
      ["aurora", "extra"], ["broken", "user"], ["dark", "user"], ["night", "user"]
    ]);
    expect(entries.find((entry) => entry.name === "night")?.theme?.name).toBe("Night");
    expect(entries.find((entry) => entry.name === "broken")?.error).toMatch(/^Invalid theme file /);
    expect(entries.find((entry) => entry.name === "dark")).toMatchObject({ error: "the built-in dark theme takes this name; rename the file" });
    expect(entries.find((entry) => entry.name === "dark")?.theme).toBeUndefined();
  });
});
