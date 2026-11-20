import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  builtinTheme,
  defaultThemesDir,
  listThemeFiles,
  loadCrewCoderTheme,
  slateCrewCoderTheme,
  type CrewCoderTheme
} from "@onpoint-dev-tools/crewcoder-tui-core/theme/crewcoder-theme";
import { errorMessage } from "./crewcoder-cli.js";
import type { PaletteCommand } from "./palette-model.js";
import { slateAppTheme, toAppTheme, type AppTheme } from "./theme.js";

/** Where the picked theme is remembered between launches. */
export type ThemeStore = {
  read(): string | undefined;
  write(selector: string): void;
};

/** Where the startup theme came from; `flag` and `env` outrank a saved pick. */
export type ThemeSource = "flag" | "env" | "saved" | "default";

export type ThemeDirs = {
  /** `$CREWCODER_HOME/themes`: the user's own themes. */
  themes: string;
  /** Themes shipped with the package (`examples/themes`). */
  examples: string;
};

export const DEFAULT_THEME = "slate";

/** The package's `examples/themes`, from `src/` and from `dist/` alike. */
export const EXAMPLE_THEMES_DIR = fileURLToPath(new URL("../examples/themes/", import.meta.url));

export function defaultThemeDirs(): ThemeDirs {
  return { themes: defaultThemesDir(), examples: EXAMPLE_THEMES_DIR };
}

/** `$CREWCODER_HOME/opentui.json` (`{ "theme": "<name>" }`); other keys are kept on write. */
export function fileThemeStore(file = path.join(process.env.CREWCODER_HOME?.trim() || path.join(os.homedir(), ".crewcoder"), "opentui.json")): ThemeStore {
  const readSettings = (): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };
  return {
    read: () => {
      const theme = readSettings().theme;
      return typeof theme === "string" && theme.trim() ? theme.trim() : undefined;
    },
    write: (selector) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ ...readSettings(), theme: selector }, null, 2)}\n`);
      fs.renameSync(temp, file);
    }
  };
}

export type StartupTheme = {
  theme: CrewCoderTheme;
  selector: string;
  source: ThemeSource;
  /** A saved theme that no longer loads: startup falls back to slate and says why. */
  warning?: string;
};

/**
 * `--theme`, then `CREWCODER_THEME`, then the saved pick, then slate. A bad
 * flag or variable is a startup error (the user asked for it just now); a bad
 * saved theme (file deleted or edited since) falls back with a warning.
 */
export function resolveStartupTheme(flag: string | undefined, env: string | undefined, store: ThemeStore, dirs: ThemeDirs): StartupTheme {
  const load = (selector: string): CrewCoderTheme => loadCrewCoderTheme(selector, { themesDir: dirs.themes, extraDirs: [dirs.examples] });
  const explicit = flag?.trim() ? { selector: flag.trim(), source: "flag" as const } : env?.trim() ? { selector: env.trim(), source: "env" as const } : undefined;
  if (explicit) return { theme: load(explicit.selector), ...explicit };
  const saved = store.read();
  if (!saved) return { theme: slateCrewCoderTheme, selector: DEFAULT_THEME, source: "default" };
  try {
    return { theme: load(saved), selector: saved, source: "saved" };
  } catch (error) {
    return { theme: slateCrewCoderTheme, selector: DEFAULT_THEME, source: "default", warning: `Saved theme "${saved}" could not be loaded, using slate: ${errorMessage(error)}` };
  }
}

const BUILTINS: ReadonlyArray<readonly [string, string]> = [
  ["slate", "Minimal slate (default)"],
  ["dark", "Gotham, the legacy UI's default (alias: crewcoder)"],
  ["light", "Light teal on pale grey-green"]
];

/** `crewcoder` is the same theme as `dark`. */
const canonical = (selector: string): string => (selector === "crewcoder" ? "dark" : selector);

type ThemeOption = PaletteCommand & { theme?: CrewCoderTheme; error?: string };

export type ThemeHost = {
  changed(): void;
};

/**
 * The active theme and the `/theme` picker: list every theme, preview the
 * highlighted one, apply and remember a pick. Unconfigured (tests, before
 * `cli.tsx` runs) it shows slate, lists only built-ins, and saves nothing.
 */
export class ThemeController {
  private readonly host: ThemeHost;
  private store: ThemeStore | undefined;
  private dirs: ThemeDirs | undefined;
  private source: ThemeSource = "default";
  /** The applied theme: what Esc returns to after a preview. */
  private applied: { theme: AppTheme; selector: string } = { theme: slateAppTheme, selector: DEFAULT_THEME };
  private previewing: { theme: AppTheme; selector: string } | undefined;
  /** Options from the last `items()` call, so previews do not reload files per keystroke. */
  private options = new Map<string, ThemeOption>();
  /** Called when the visible theme changes (the renderer background); wired by cli.tsx. */
  onChange: ((theme: AppTheme) => void) | undefined;

  constructor(host: ThemeHost) {
    this.host = host;
  }

  configure(startup: StartupTheme, store: ThemeStore, dirs: ThemeDirs): void {
    this.store = store;
    this.dirs = dirs;
    this.source = startup.source;
    this.applied = { theme: toAppTheme(startup.theme), selector: canonical(startup.selector) };
    this.previewing = undefined;
  }

  /** The theme on screen: a preview while the picker browses, else the applied one. */
  get current(): AppTheme {
    return (this.previewing ?? this.applied).theme;
  }

  get selector(): string {
    return this.applied.selector;
  }

  /** Built-ins, then the user's themes, then shipped examples; broken files say why. */
  items(): PaletteCommand[] {
    const examples = this.dirs?.examples;
    // The palette shows groups in first-item order: the user's own themes before examples.
    const files = (this.dirs ? listThemeFiles([this.dirs.themes, this.dirs.examples]) : [])
      .sort((a, b) => Number(a.dir === examples) - Number(b.dir === examples));
    const options: ThemeOption[] = [
      ...BUILTINS.map(([name, description]) => ({ id: name, label: name, description, group: "Built-in", theme: builtinTheme(name) })),
      ...files.map((file) => ({
        id: file.name,
        label: file.name,
        description: file.error ? `Unusable: ${file.error}` : file.theme?.name && file.theme.name !== file.name ? file.theme.name : undefined,
        group: file.dir === examples ? "Examples" : `Your themes (${this.dirs ? shortHome(this.dirs.themes) : ""})`,
        ...(file.theme ? { theme: file.theme } : {}),
        ...(file.error ? { error: file.error } : {})
      }))
    ];
    // A theme given as a path (`--theme ./mine.json`) is not in any directory; keep it pickable.
    if (!options.some((option) => option.id === this.applied.selector)) {
      options.unshift({ id: this.applied.selector, label: path.basename(this.applied.selector), description: this.applied.selector, group: "Current" });
    }
    this.options = new Map(options.map((option) => [option.id, option]));
    return options.map(({ theme: _theme, error: _error, ...item }) => ({ ...item, current: item.id === this.applied.selector }));
  }

  /** Show the highlighted theme without applying it; unusable entries keep the screen as is. */
  preview(id: string | undefined): void {
    if (id === undefined) return;
    const option = this.options.get(id);
    const next = id === this.applied.selector ? undefined : option?.theme ? { theme: toAppTheme(option.theme), selector: id } : this.previewing;
    if (next === this.previewing) return;
    this.previewing = next;
    this.emit();
  }

  /** Esc: back to the applied theme. */
  endPreview(): void {
    if (!this.previewing) return;
    this.previewing = undefined;
    this.emit();
  }

  /**
   * Apply and remember a theme by name or path (picker Enter, `/theme <name>`).
   * Returns the alert text; throws a readable error when it cannot be loaded.
   */
  apply(id: string): { title: string; body?: string } {
    const selector = canonical(id.trim());
    const cached = this.options.get(selector);
    if (cached?.error) throw new Error(cached.error);
    const theme = cached?.theme ?? loadCrewCoderTheme(selector, { themesDir: this.dirs?.themes, extraDirs: this.dirs ? [this.dirs.examples] : [] });
    this.applied = { theme: toAppTheme(theme), selector };
    this.previewing = undefined;
    this.emit();
    let body: string | undefined;
    try {
      this.store?.write(selector);
    } catch (error) {
      return { title: `Theme: ${selector}`, body: `Applied for this session, but it could not be saved: ${errorMessage(error)}` };
    }
    if (this.source === "flag") body = "Saved, but --theme picks the theme while it is passed.";
    else if (this.source === "env") body = "Saved, but CREWCODER_THEME picks the theme while it is set.";
    else if (this.store) body = "Saved for next launch.";
    return { title: `Theme: ${selector}`, ...(body ? { body } : {}) };
  }

  private emit(): void {
    this.onChange?.(this.current);
    this.host.changed();
  }
}

function shortHome(dir: string): string {
  const home = os.homedir();
  return dir === home || dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir;
}
