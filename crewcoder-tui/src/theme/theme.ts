import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

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
};

type ThemeColorKey = Exclude<keyof CrewCoderTheme, "name">;
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

const colorValueSchema = z.union([
  z.string().min(1),
  z.number().int().min(0).max(255)
]);

const themeJsonSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1),
  vars: z.record(colorValueSchema).optional(),
  colors: z.object(Object.fromEntries(colorKeys.map((key) => [key, colorValueSchema.optional()])) as Record<ThemeColorKey, z.ZodOptional<typeof colorValueSchema>>).strict()
}).strict();

type ThemeJson = z.infer<typeof themeJsonSchema>;

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
  glow: "#33859e"
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
  glow: "#33859e"
};

const builtinThemes: Record<string, CrewCoderTheme> = {
  dark: crewCoderTheme,
  crewcoder: crewCoderTheme,
  light: lightCrewCoderTheme
};

export function loadCrewCoderTheme(selector = process.env.CREWCODER_THEME): CrewCoderTheme {
  const requested = selector?.trim();
  if (!requested) return crewCoderTheme;
  const builtin = builtinThemes[requested];
  if (builtin) return builtin;
  const themePath = resolveThemePath(requested);
  if (!themePath) throw new Error(`Theme not found: ${requested}`);
  return loadCrewCoderThemeFromPath(themePath);
}

export function loadCrewCoderThemeFromPath(themePath: string): CrewCoderTheme {
  const parsed = themeJsonSchema.parse(JSON.parse(fs.readFileSync(themePath, "utf8")));
  return createThemeFromJson(parsed);
}

export function listBuiltinThemeNames(): string[] {
  return Object.keys(builtinThemes);
}

function resolveThemePath(selector: string): string | undefined {
  const directPath = path.resolve(selector);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) return directPath;
  const namedPath = path.join(os.homedir(), ".crewcoder", "themes", `${selector}.json`);
  if (fs.existsSync(namedPath) && fs.statSync(namedPath).isFile()) return namedPath;
  return undefined;
}

function createThemeFromJson(themeJson: ThemeJson): CrewCoderTheme {
  const colors = { ...crewCoderTheme, name: themeJson.name };
  const vars = themeJson.vars ?? {};
  for (const key of colorKeys) {
    const value = themeJson.colors[key];
    if (value !== undefined) colors[key] = resolveColorValue(value, vars);
  }
  return colors;
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

function ansi256ToHex(index: number): string {
  const basic = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff"
  ];
  if (index < basic.length) return basic[index]!;
  if (index < 232) {
    const cube = index - 16;
    const r = Math.floor(cube / 36);
    const g = Math.floor((cube % 36) / 6);
    const b = cube % 6;
    return `#${cubeChannelToHex(r)}${cubeChannelToHex(g)}${cubeChannelToHex(b)}`;
  }
  const gray = 8 + (index - 232) * 10;
  const channel = gray.toString(16).padStart(2, "0");
  return `#${channel}${channel}${channel}`;
}

function cubeChannelToHex(value: number): string {
  const channel = value === 0 ? 0 : 55 + value * 40;
  return channel.toString(16).padStart(2, "0");
}
