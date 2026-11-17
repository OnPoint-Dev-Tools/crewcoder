export type AppAction =
  | "abort" | "quit" | "approve" | "deny"
  | "paletteClose" | "paletteUp" | "paletteDown" | "paletteSelect" | "paletteBackspace"
  | "composerSubmit" | "composerNewline"
  | "summaryApply" | "summaryReset" | "summaryCancel";

export type KeyLike = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** OpenTUI KeyEvent: stops the focused renderable (the composer) from also handling the key. */
  preventDefault?: () => void;
};

/**
 * Default key chords per action. Keep key checks routed through this table so
 * bindings stay configurable instead of being hardcoded at call sites.
 */
export const DEFAULT_APP_KEYBINDINGS: Readonly<Record<AppAction, readonly string[]>> = {
  abort: ["escape"],
  quit: ["ctrl+c"],
  approve: ["ctrl+y"],
  deny: ["ctrl+n"],
  paletteClose: ["escape"],
  paletteUp: ["up"],
  paletteDown: ["down"],
  paletteSelect: ["return"],
  paletteBackspace: ["backspace", "delete"],
  // Shift+Enter needs the kitty keyboard protocol (on by default). Ctrl+J works
  // everywhere: kitty reports it as ctrl+j, legacy terminals as "linefeed".
  composerSubmit: ["return", "kpenter"],
  composerNewline: ["shift+return", "ctrl+j", "linefeed", "meta+return"],
  summaryApply: ["ctrl+s"],
  summaryReset: ["ctrl+r"],
  summaryCancel: ["escape"]
};

/** An OpenTUI textarea key binding (`@opentui/core` `KeyBinding`). */
export type TextareaBinding<Action extends string> = { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; action: Action };

/** Textarea bindings for app actions, so composer keys stay configurable. */
export function textareaBindings<Action extends string>(
  actions: Readonly<Partial<Record<AppAction, Action>>>,
  bindings: Readonly<Record<AppAction, readonly string[]>> = DEFAULT_APP_KEYBINDINGS
): TextareaBinding<Action>[] {
  return (Object.entries(actions) as Array<[AppAction, Action]>).flatMap(([appAction, action]) =>
    bindings[appAction].map((chord) => {
      const parts = chord.toLowerCase().split("+");
      const name = parts.pop() ?? "";
      return { name, ctrl: parts.includes("ctrl"), meta: parts.includes("meta"), shift: parts.includes("shift"), action };
    }));
}

export function matchesAction(
  key: KeyLike,
  action: AppAction,
  bindings: Readonly<Record<AppAction, readonly string[]>> = DEFAULT_APP_KEYBINDINGS
): boolean {
  return bindings[action].some((chord) => matchesChord(key, chord));
}

/** Short human label for the first chord of an action, e.g. `^Y`. */
export function actionLabel(
  action: AppAction,
  bindings: Readonly<Record<AppAction, readonly string[]>> = DEFAULT_APP_KEYBINDINGS
): string {
  const parts = (bindings[action][0] ?? "").split("+");
  const key = parts.pop() ?? "";
  const prefix = parts.map((modifier) => MODIFIER_LABELS[modifier] ?? `${modifier}+`).join("");
  return `${prefix}${key.length === 1 ? key.toUpperCase() : key}`;
}

const MODIFIER_LABELS: Readonly<Record<string, string>> = { ctrl: "^", meta: "M-", shift: "S-" };

function matchesChord(key: KeyLike, chord: string): boolean {
  const parts = chord.toLowerCase().split("+");
  const name = parts.pop();
  return name === key.name.toLowerCase()
    && parts.includes("ctrl") === key.ctrl
    && parts.includes("meta") === key.meta
    && parts.includes("shift") === key.shift;
}
