export type AppAction = "abort" | "quit" | "approve" | "deny";

export type KeyLike = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

/**
 * Default key chords per action. Keep key checks routed through this table so
 * bindings stay configurable instead of being hardcoded at call sites.
 */
export const DEFAULT_APP_KEYBINDINGS: Readonly<Record<AppAction, readonly string[]>> = {
  abort: ["escape"],
  quit: ["ctrl+c"],
  approve: ["ctrl+y"],
  deny: ["ctrl+n"]
};

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
