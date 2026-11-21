import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crewCoderTheme, lightCrewCoderTheme, slateCrewCoderTheme } from "@onpoint-dev-tools/crewcoder-tui-core/theme/crewcoder-theme";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXAMPLE_THEMES_DIR,
  ThemeController,
  fileThemeStore,
  resolveStartupTheme,
  type StartupTheme,
  type ThemeDirs,
  type ThemeStore
} from "../theme-controller.js";

let dir: string;
let dirs: ThemeDirs;

/** An in-memory store; `fail` makes writes throw like a read-only home. */
function memoryStore(initial?: string, fail = false): ThemeStore & { saved: string | undefined } {
  const store = {
    saved: initial,
    read: () => store.saved,
    write: (selector: string) => {
      if (fail) throw new Error("EROFS: read-only file system");
      store.saved = selector;
    }
  };
  return store;
}

function writeTheme(name: string, body: unknown): void {
  fs.writeFileSync(path.join(dirs.themes, `${name}.json`), typeof body === "string" ? body : JSON.stringify(body));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-theme-ctl-"));
  dirs = { themes: path.join(dir, "themes"), examples: EXAMPLE_THEMES_DIR };
  fs.mkdirSync(dirs.themes);
});

describe("resolveStartupTheme", () => {
  it("uses --theme, then CREWCODER_THEME, then the saved pick, then slate", () => {
    const store = memoryStore("light");
    expect(resolveStartupTheme("dark", "ember", store, dirs)).toMatchObject({ selector: "dark", source: "flag", theme: crewCoderTheme });
    expect(resolveStartupTheme(undefined, "ember", store, dirs)).toMatchObject({ selector: "ember", source: "env" });
    expect(resolveStartupTheme(undefined, undefined, store, dirs)).toMatchObject({ selector: "light", source: "saved", theme: lightCrewCoderTheme });
    expect(resolveStartupTheme("  ", "", memoryStore(), dirs)).toMatchObject({ selector: "slate", source: "default", theme: slateCrewCoderTheme });
  });

  it("finds shipped examples and the user's themes by name", () => {
    writeTheme("mine", { name: "mine", extends: "slate", colors: { text: "#ffffff" } });
    expect(resolveStartupTheme(undefined, undefined, memoryStore("ember"), dirs).theme.name).toBe("ember");
    expect(resolveStartupTheme(undefined, undefined, memoryStore("mine"), dirs).theme.text).toBe("#ffffff");
  });

  it("fails on a bad --theme or CREWCODER_THEME: the user asked for it", () => {
    expect(() => resolveStartupTheme("nope", undefined, memoryStore(), dirs)).toThrow("Theme not found: nope");
    expect(() => resolveStartupTheme(undefined, "nope", memoryStore(), dirs)).toThrow("Theme not found: nope");
  });

  it("falls back to slate with a warning when the saved theme no longer loads", () => {
    writeTheme("broken", "{");
    const result = resolveStartupTheme(undefined, undefined, memoryStore("broken"), dirs);
    expect(result).toMatchObject({ selector: "slate", source: "default", theme: slateCrewCoderTheme });
    expect(result.warning).toMatch(/Saved theme "broken" could not be loaded, using slate: Invalid theme file/);
  });
});

describe("fileThemeStore", () => {
  it("reads nothing from a missing or invalid file", () => {
    expect(fileThemeStore(path.join(dir, "absent.json")).read()).toBeUndefined();
    fs.writeFileSync(path.join(dir, "bad.json"), "not json");
    expect(fileThemeStore(path.join(dir, "bad.json")).read()).toBeUndefined();
  });

  it("writes the theme, keeps other settings, and creates the directory", () => {
    const file = path.join(dir, "nested", "opentui.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ other: 1, theme: "dark" }));
    const store = fileThemeStore(file);
    store.write("ember");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ other: 1, theme: "ember" });
    expect(store.read()).toBe("ember");
    const fresh = fileThemeStore(path.join(dir, "new-dir", "opentui.json"));
    fresh.write("light");
    expect(fresh.read()).toBe("light");
  });
});

function configured(startup: Partial<StartupTheme> = {}, store = memoryStore()): { controller: ThemeController; store: typeof store; changed: ReturnType<typeof vi.fn> } {
  const changed = vi.fn();
  const controller = new ThemeController({ changed });
  controller.configure({ theme: slateCrewCoderTheme, selector: "slate", source: "default", ...startup }, store, dirs);
  return { controller, store, changed };
}

describe("ThemeController.items", () => {
  it("lists built-ins, the user's themes, then examples, marking the applied one", () => {
    writeTheme("mine", { name: "My Night", extends: "slate" });
    const items = configured().controller.items();
    expect(items.map((item) => [item.group, item.id])).toEqual([
      ["Built-in", "slate"],
      ["Built-in", "dark"],
      ["Built-in", "light"],
      [expect.stringMatching(/^Your themes \(/), "mine"],
      ["Examples", "ember"]
    ]);
    expect(items.find((item) => item.id === "slate")?.current).toBe(true);
    expect(items.find((item) => item.id === "mine")?.description).toBe("My Night");
  });

  it("lists unusable files with the reason instead of hiding them", () => {
    writeTheme("broken", { name: "x", colors: { text: "#fff" } });
    writeTheme("light", { name: "light copy" });
    const items = configured().controller.items();
    expect(items.find((item) => item.id === "broken")?.description).toMatch(/^Unusable: .*Invalid theme hex color: #fff/);
    // The built-in keeps its name; the file says why it is unreachable.
    expect(items.filter((item) => item.id === "light").map((item) => item.description)).toEqual([
      "Light teal on pale grey-green",
      "Unusable: the built-in light theme takes this name; rename the file"
    ]);
  });

  it("marks dark for the crewcoder alias, and keeps a path theme pickable", () => {
    expect(configured({ theme: crewCoderTheme, selector: "crewcoder" }).controller.items().find((item) => item.current)?.id).toBe("dark");
    const file = path.join(dir, "elsewhere.json");
    fs.writeFileSync(file, JSON.stringify({ name: "elsewhere" }));
    const items = configured({ selector: file, source: "flag" }).controller.items();
    expect(items[0]).toMatchObject({ id: file, label: "elsewhere.json", group: "Current", current: true });
  });

  it("lists only built-ins before cli.tsx configures it", () => {
    const controller = new ThemeController({ changed: vi.fn() });
    expect(controller.items().map((item) => item.id)).toEqual(["slate", "dark", "light"]);
    expect(controller.current.ui.name).toBe("slate");
  });
});

describe("ThemeController preview and apply", () => {
  it("previews the highlighted theme and returns to the applied one", () => {
    const { controller, store, changed } = configured();
    const onChange = vi.fn();
    controller.onChange = onChange;
    controller.items();
    controller.preview("dark");
    expect(controller.current.ui.colors.background).toBe(crewCoderTheme.background);
    expect(onChange).toHaveBeenLastCalledWith(controller.current);
    controller.endPreview();
    expect(controller.current.ui.colors.background).toBe(slateCrewCoderTheme.background);
    expect(controller.selector).toBe("slate");
    expect(store.saved).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("keeps the screen on an unusable entry and does nothing for the applied one", () => {
    writeTheme("broken", "{");
    const { controller, changed } = configured();
    controller.items();
    controller.preview("ember");
    controller.preview("broken");
    expect(controller.current.ui.name).toBe("ember");
    controller.preview("slate");
    expect(controller.current.ui.name).toBe("slate");
    controller.preview("slate");
    controller.preview(undefined);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("applies, saves, and says where it is saved", () => {
    const { controller, store } = configured();
    controller.items();
    controller.preview("light");
    expect(controller.apply("ember")).toEqual({ title: "Theme: ember", body: "Saved for next launch." });
    expect(store.saved).toBe("ember");
    expect(controller.selector).toBe("ember");
    controller.endPreview();
    expect(controller.current.ui.name).toBe("ember");
  });

  it("applies a typed name without opening the list, saving the canonical name", () => {
    const { controller, store } = configured();
    expect(controller.apply("crewcoder").title).toBe("Theme: dark");
    expect(store.saved).toBe("dark");
    expect(controller.current.ui.colors.background).toBe(crewCoderTheme.background);
  });

  it("refuses unusable themes and keeps the applied one", () => {
    writeTheme("broken", "{");
    const { controller, store } = configured();
    controller.items();
    expect(() => controller.apply("broken")).toThrow(/Invalid theme file/);
    expect(() => controller.apply("missing")).toThrow("Theme not found: missing");
    expect(controller.selector).toBe("slate");
    expect(store.saved).toBeUndefined();
  });

  it("says when --theme or CREWCODER_THEME will win at the next launch", () => {
    expect(configured({ source: "flag" }).controller.apply("light").body).toBe("Saved, but --theme picks the theme while it is passed.");
    expect(configured({ source: "env" }).controller.apply("light").body).toBe("Saved, but CREWCODER_THEME picks the theme while it is set.");
  });

  it("still applies when saving fails", () => {
    const { controller } = configured({}, memoryStore(undefined, true));
    expect(controller.apply("light")).toEqual({ title: "Theme: light", body: "Applied for this session, but it could not be saved: EROFS: read-only file system" });
    expect(controller.selector).toBe("light");
  });
});
