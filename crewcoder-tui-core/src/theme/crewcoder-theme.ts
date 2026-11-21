import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Tree-sitter scope colors for highlighted code. Base capture names; UIs map
 * related scopes (`conditional`, `method`, ...) onto these.
 */
export type SyntaxColors = {
  keyword: string;
  string: string;
  number: string;
  constant: string;
  comment: string;
  function: string;
  type: string;
  property: string;
  operator: string;
  punctuation: string;
  tag: string;
  attribute: string;
  escape: string;
};

/**
 * Markdown element colors: rendered replies, and markdown source (`.md` read
 * output, diffs, fences). `strong`/`emphasis` equal to the body text keep
 * them plain apart from bold/italic.
 */
export type MarkdownColors = {
  heading: string;
  strong: string;
  emphasis: string;
  strikethrough: string;
  /** Inline code spans and code in markdown source. */
  code: string;
  link: string;
  linkUrl: string;
  listMarker: string;
  quote: string;
};

/**
 * A CrewCoder theme, shared by both TUIs and by theme JSON files. The legacy
 * UI reads the color tokens directly; the OpenTUI UI maps them onto its own
 * component tokens. `syntax` colors highlighted code, `markdown` markdown
 * elements.
 */
export type CrewCoderTheme = {
  name: string;
  background: string;
  backgroundAlt: string;
  surface: string;
  surfaceAlt: string;
  surfaceGlow: string;
  panel: string;
  panelAlt: string;
  panelThinking: string;
  selectedBg: string;
  diffAddBg: string;
  diffDelBg: string;
  border: string;
  borderStrong: string;
  primary: string;
  text: string;
  muted: string;
  subtle: string;
  success: string;
  warning: string;
  danger: string;
  accent: string;
  accent2: string;
  accent3: string;
  glow: string;
  syntax: SyntaxColors;
  markdown: MarkdownColors;
};

type ThemeColorKey = Exclude<keyof CrewCoderTheme, "name" | "syntax" | "markdown">;
type ThemeColorValue = string | number;

const colorKeys = [
  "background",
  "backgroundAlt",
  "surface",
  "surfaceAlt",
  "surfaceGlow",
  "panel",
  "panelAlt",
  "panelThinking",
  "selectedBg",
  "diffAddBg",
  "diffDelBg",
  "border",
  "borderStrong",
  "primary",
  "text",
  "muted",
  "subtle",
  "success",
  "warning",
  "danger",
  "accent",
  "accent2",
  "accent3",
  "glow"
] as const satisfies readonly ThemeColorKey[];

export const SYNTAX_KEYS = [
  "keyword",
  "string",
  "number",
  "constant",
  "comment",
  "function",
  "type",
  "property",
  "operator",
  "punctuation",
  "tag",
  "attribute",
  "escape"
] as const satisfies readonly (keyof SyntaxColors)[];

export const MARKDOWN_KEYS = [
  "heading",
  "strong",
  "emphasis",
  "strikethrough",
  "code",
  "link",
  "linkUrl",
  "listMarker",
  "quote"
] as const satisfies readonly (keyof MarkdownColors)[];

const colorValueSchema = z.union([
  z.string().min(1),
  z.number().int().min(0).max(255)
]);

function optionalColors<const Keys extends readonly string[]>(keys: Keys) {
  return z.object(Object.fromEntries(keys.map((key) => [key, colorValueSchema.optional()])) as Record<Keys[number], z.ZodOptional<typeof colorValueSchema>>).strict();
}

const themeJsonSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1),
  /** Built-in theme the file is merged over (default `dark`, as before `extends` existed). */
  extends: z.string().min(1).optional(),
  vars: z.record(colorValueSchema).optional(),
  colors: optionalColors(colorKeys).optional(),
  syntax: optionalColors(SYNTAX_KEYS).optional(),
  markdown: optionalColors(MARKDOWN_KEYS).optional()
}).strict();

type ThemeJson = z.infer<typeof themeJsonSchema>;

/** Gotham: the legacy UI's default and its required visual identity. */
export const crewCoderTheme: CrewCoderTheme = {
  name: "dark",
  background: "#0c1014",
  backgroundAlt: "#11151c",
  surface: "#0a1922",
  surfaceAlt: "#0e202b",
  surfaceGlow: "#0a3749",
  panel: "#0d161d",
  panelAlt: "#11202b",
  panelThinking: "#0f1a22",
  selectedBg: "#0a3749",
  diffAddBg: "#123528",
  diffDelBg: "#3a1512",
  border: "#195466",
  borderStrong: "#33859e",
  primary: "#33859e",
  text: "#c3e6e4",
  muted: "#6f9e9b",
  subtle: "#99d1ce",
  success: "#2aa889",
  warning: "#edb443",
  danger: "#c23127",
  accent: "#33859e",
  accent2: "#2aa889",
  accent3: "#195466",
  glow: "#33859e",
  // Gotham's own palette (orange, yellow, magenta, cyan, green, red).
  syntax: {
    keyword: "#888ca6",
    string: "#2aa889",
    number: "#d26937",
    constant: "#d26937",
    comment: "#6f9e9b",
    function: "#33859e",
    type: "#edb443",
    property: "#99d1ce",
    operator: "#599cab",
    punctuation: "#6f9e9b",
    tag: "#c23127",
    attribute: "#d26937",
    escape: "#edb443"
  },
  markdown: {
    heading: "#33859e",
    strong: "#c3e6e4",
    emphasis: "#c3e6e4",
    strikethrough: "#6f9e9b",
    code: "#2aa889",
    link: "#599cab",
    linkUrl: "#6f9e9b",
    listMarker: "#6f9e9b",
    quote: "#6f9e9b"
  }
};

export const lightCrewCoderTheme: CrewCoderTheme = {
  name: "light",
  background: "#eef4f3",
  backgroundAlt: "#e3ecea",
  surface: "#d9e5e3",
  surfaceAlt: "#cedcda",
  surfaceGlow: "#d0e4e6",
  panel: "#d9e5e3",
  panelAlt: "#cedcda",
  panelThinking: "#d0e4e6",
  selectedBg: "#aacdcf",
  diffAddBg: "#cbe8db",
  diffDelBg: "#f0d4d1",
  border: "#9cbcba",
  borderStrong: "#195466",
  primary: "#1f6b80",
  text: "#11282c",
  muted: "#4c6c6b",
  subtle: "#5f817f",
  success: "#1f7d64",
  warning: "#9a6d16",
  danger: "#a3281f",
  accent: "#1f6b80",
  accent2: "#1f7d64",
  accent3: "#195466",
  glow: "#33859e",
  // Darker tones that keep contrast on the light background.
  syntax: {
    keyword: "#6a4c93",
    string: "#1f7d64",
    number: "#a8541f",
    constant: "#a8541f",
    comment: "#5f817f",
    function: "#1f6b80",
    type: "#8a6214",
    property: "#2c4a50",
    operator: "#4c6c6b",
    punctuation: "#5f817f",
    tag: "#a3281f",
    attribute: "#a8541f",
    escape: "#9a6d16"
  },
  markdown: {
    heading: "#1f6b80",
    strong: "#11282c",
    emphasis: "#11282c",
    strikethrough: "#4c6c6b",
    code: "#a8541f",
    link: "#1f6b80",
    linkUrl: "#4c6c6b",
    listMarker: "#4c6c6b",
    quote: "#4c6c6b"
  }
};

/** Minimal slate: the OpenTUI UI's default. */
export const slateCrewCoderTheme: CrewCoderTheme = {
  name: "slate",
  background: "#101216",
  backgroundAlt: "#15181d",
  surface: "#181b20",
  surfaceAlt: "#1e2127",
  surfaceGlow: "#292d34",
  panel: "#181b20",
  panelAlt: "#292d34",
  panelThinking: "#181b20",
  selectedBg: "#343942",
  diffAddBg: "#18241c",
  diffDelBg: "#2a1a1c",
  border: "#3b414b",
  borderStrong: "#a7adb7",
  primary: "#a7adb7",
  text: "#d3d6dc",
  muted: "#858c97",
  subtle: "#c0c5ce",
  success: "#aab8ad",
  warning: "#c4b99f",
  danger: "#c28f91",
  accent: "#c0c5ce",
  accent2: "#aab8ad",
  accent3: "#3b414b",
  glow: "#a7adb7",
  syntax: {
    keyword: "#b7a6cf",
    string: "#a9bf9c",
    number: "#d0b48f",
    constant: "#d0b48f",
    comment: "#6f7682",
    function: "#94b3d1",
    type: "#89bdb5",
    property: "#c0c5ce",
    operator: "#a7adb7",
    punctuation: "#858c97",
    tag: "#c99295",
    attribute: "#d0b48f",
    escape: "#c4b99f"
  },
  // The colors replies used before markdown colors were themeable.
  markdown: {
    heading: "#a7adb7",
    strong: "#d3d6dc",
    emphasis: "#d3d6dc",
    strikethrough: "#858c97",
    code: "#c0c5ce",
    link: "#a7adb7",
    linkUrl: "#858c97",
    listMarker: "#858c97",
    quote: "#858c97"
  }
};

const builtinThemes: Readonly<Record<string, CrewCoderTheme>> = {
  dark: crewCoderTheme,
  crewcoder: crewCoderTheme,
  light: lightCrewCoderTheme,
  slate: slateCrewCoderTheme
};

export type ThemeLoadOptions = {
  /** Theme used when no selector is given (legacy: `dark`, OpenTUI: `slate`). */
  fallback?: CrewCoderTheme;
  /** Directory holding named `<name>.json` themes (default `$CREWCODER_HOME/themes`). */
  themesDir?: string;
  /** More directories searched for a named theme after `themesDir` (shipped examples). */
  extraDirs?: readonly string[];
};

/** A `<name>.json` file found in a themes directory. */
export type ThemeFileEntry = {
  /** File name without `.json`; what `--theme <name>` resolves. */
  name: string;
  path: string;
  /** The directory it was found in. */
  dir: string;
  /** The loaded theme, when the file is valid and reachable by name. */
  theme?: CrewCoderTheme;
  /** Why it cannot be used (invalid file, or a built-in with the same name wins). */
  error?: string;
};

/**
 * Resolve a `--theme` / `CREWCODER_THEME` value: a built-in name, a JSON file
 * path, or a named file in the themes directory. Throws a readable error for an
 * unknown name or an invalid file.
 */
export function loadCrewCoderTheme(selector = process.env.CREWCODER_THEME, options: ThemeLoadOptions = {}): CrewCoderTheme {
  const requested = selector?.trim();
  if (!requested) return options.fallback ?? crewCoderTheme;
  const builtin = builtinTheme(requested);
  if (builtin) return builtin;
  const themePath = resolveThemePath(requested, [options.themesDir ?? defaultThemesDir(), ...(options.extraDirs ?? [])]);
  if (!themePath) throw new Error(`Theme not found: ${requested} (built-in themes: ${listBuiltinThemeNames().join(", ")})`);
  return loadCrewCoderThemeFromPath(themePath);
}

export function loadCrewCoderThemeFromPath(themePath: string): CrewCoderTheme {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(themePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid theme file ${themePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = themeJsonSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid theme file ${themePath}: ${issues}`);
  }
  try {
    return createThemeFromJson(parsed.data);
  } catch (error) {
    throw new Error(`Invalid theme file ${themePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function listBuiltinThemeNames(): string[] {
  return Object.keys(builtinThemes);
}

/** The built-in theme with this name (`crewcoder` is an alias of `dark`), if any. */
export function builtinTheme(name: string): CrewCoderTheme | undefined {
  // hasOwn guards against prototype keys such as "constructor".
  return Object.hasOwn(builtinThemes, name) ? builtinThemes[name] : undefined;
}

/** `$CREWCODER_HOME/themes`, where named custom themes live. */
export function defaultThemesDir(): string {
  const home = process.env.CREWCODER_HOME?.trim() || path.join(os.homedir(), ".crewcoder");
  return path.join(home, "themes");
}

/**
 * Every `<name>.json` in `dirs`, sorted by name, each loaded or with the reason
 * it cannot be used. An earlier directory wins a name; a built-in name always
 * wins (the file is listed with an error saying so). Missing directories are
 * skipped. Never throws.
 */
export function listThemeFiles(dirs: readonly string[]): ThemeFileEntry[] {
  const seen = new Set<string>();
  const entries: ThemeFileEntry[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const name = file.slice(0, -".json".length);
      const filePath = path.join(dir, file);
      if (!name || seen.has(name) || !isFile(filePath)) continue;
      seen.add(name);
      if (builtinTheme(name)) {
        entries.push({ name, path: filePath, dir, error: `the built-in ${name} theme takes this name; rename the file` });
        continue;
      }
      try {
        entries.push({ name, path: filePath, dir, theme: loadCrewCoderThemeFromPath(filePath) });
      } catch (error) {
        entries.push({ name, path: filePath, dir, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveThemePath(selector: string, dirs: readonly string[]): string | undefined {
  const directPath = path.resolve(selector);
  if (isFile(directPath)) return directPath;
  for (const dir of dirs) {
    const namedPath = path.join(dir, `${selector}.json`);
    if (isFile(namedPath)) return namedPath;
  }
  return undefined;
}

function isFile(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function createThemeFromJson(themeJson: ThemeJson): CrewCoderTheme {
  const base = themeJson.extends ? builtinTheme(themeJson.extends) : crewCoderTheme;
  if (!base) throw new Error(`extends: unknown built-in theme ${themeJson.extends} (built-in themes: ${listBuiltinThemeNames().join(", ")})`);
  const vars = themeJson.vars ?? {};
  const resolve = <Key extends string>(source: Partial<Record<Key, ThemeColorValue>> | undefined, key: Key, fallback: string): string => {
    const value = source?.[key];
    return value === undefined ? fallback : resolveColorValue(value, vars);
  };
  const colors = Object.fromEntries(colorKeys.map((key) => [key, resolve(themeJson.colors, key, base[key])])) as Record<ThemeColorKey, string>;
  const syntax = Object.fromEntries(SYNTAX_KEYS.map((key) => [key, resolve(themeJson.syntax, key, base.syntax[key])])) as SyntaxColors;
  const markdown = Object.fromEntries(MARKDOWN_KEYS.map((key) => [key, resolve(themeJson.markdown, key, base.markdown[key])])) as MarkdownColors;
  return { ...colors, name: themeJson.name, syntax, markdown };
}

function resolveColorValue(value: ThemeColorValue, vars: Record<string, ThemeColorValue>, visited = new Set<string>()): string {
  if (typeof value === "number") return ansi256ToHex(value);
  if (value.startsWith("#")) return normalizeHex(value);
  if (visited.has(value)) throw new Error(`Circular theme variable reference: ${value}`);
  const variable = vars[value];
  if (variable === undefined) throw new Error(`Unknown theme variable: ${value}`);
  visited.add(value);
  return resolveColorValue(variable, vars, visited);
}

function normalizeHex(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`Invalid theme hex color: ${hex}`);
  return hex.toLowerCase();
}

const ANSI_BASIC = [
  "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"
] as const;

function ansi256ToHex(index: number): string {
  if (index < ANSI_BASIC.length) return ANSI_BASIC[index]!;
  if (index < 232) {
    const cube = index - 16;
    const r = Math.floor(cube / 36);
    const g = Math.floor((cube % 36) / 6);
    const b = cube % 6;
    return `#${cubeChannelToHex(r)}${cubeChannelToHex(g)}${cubeChannelToHex(b)}`;
  }
  const channel = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
  return `#${channel}${channel}${channel}`;
}

function cubeChannelToHex(value: number): string {
  const channel = value === 0 ? 0 : 55 + value * 40;
  return channel.toString(16).padStart(2, "0");
}
