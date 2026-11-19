export type AppAction =
  | "abort" | "quit" | "approve" | "deny"
  | "paletteClose" | "paletteUp" | "paletteDown" | "paletteSelect" | "paletteBackspace" | "sessionBranch"
  | "composerSubmit" | "composerNewline" | "composerHistoryPrev" | "composerHistoryNext"
  | "mentionUp" | "mentionDown" | "mentionSelect" | "mentionClose"
  | "pasteClipboard" | "clearAttachments" | "togglePalette" | "openModes" | "toggleSidebar"
  | "summaryApply" | "summaryReset" | "summaryCancel"
  | "questionPrev" | "questionNext" | "questionSubmit" | "questionCancel"
  | "questionYes" | "questionNo" | "questionScrollUp" | "questionScrollDown"
  | "transcriptPageUp" | "transcriptPageDown" | "transcriptTop" | "transcriptBottom" | "toggleToolOutput" | "toggleDiffs";

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
  // In /sessions: branch the highlighted session instead of resuming it. Not a
  // letter (typed letters search) and not Ctrl+B (the sidebar).
  sessionBranch: ["tab"],
  // Shift+Enter needs the kitty keyboard protocol (on by default). Ctrl+J works
  // everywhere: kitty reports it as ctrl+j, legacy terminals as "linefeed".
  composerSubmit: ["return", "kpenter"],
  composerNewline: ["shift+return", "ctrl+j", "linefeed", "meta+return"],
  // Move between wrapped lines; on the first/last line, recall sent messages.
  composerHistoryPrev: ["up"],
  composerHistoryNext: ["down"],
  // `@` path suggestions under the composer, while the list is open.
  mentionUp: ["up"],
  mentionDown: ["down"],
  mentionSelect: ["return", "tab"],
  mentionClose: ["escape"],
  // Composer shortcuts (legacy). Ctrl+V attaches a clipboard image, else pastes
  // clipboard text; terminal paste (Ctrl+Shift+V) still pastes text directly.
  pasteClipboard: ["ctrl+v", "meta+v"],
  clearAttachments: ["ctrl+x"],
  togglePalette: ["ctrl+p"],
  // Legacy terminals send Tab and Ctrl+I as the same byte; kitty tells them apart.
  openModes: ["tab", "ctrl+i"],
  // The right sidebar (legacy Ctrl+B); /sidebar does the same.
  toggleSidebar: ["ctrl+b"],
  summaryApply: ["ctrl+s"],
  summaryReset: ["ctrl+r"],
  summaryCancel: ["escape"],
  // Extension questions. Left/right only move between choices for confirm,
  // select, and component questions; a text question leaves them to its field.
  questionPrev: ["up", "left"],
  questionNext: ["down", "right"],
  questionSubmit: ["return", "kpenter"],
  questionCancel: ["escape"],
  // Bare y/n answer only a Yes/No question, which has no text field to type into.
  questionYes: ["y"],
  questionNo: ["n"],
  questionScrollUp: ["pageup"],
  questionScrollDown: ["pagedown"],
  // The transcript scrollbox; the mouse wheel scrolls it too.
  transcriptPageUp: ["pageup"],
  transcriptPageDown: ["pagedown"],
  transcriptTop: ["ctrl+home"],
  transcriptBottom: ["ctrl+end"],
  // Expand or collapse every tool's output at once.
  toggleToolOutput: ["ctrl+o"],
  // Hide or show every edit's inline diff at once.
  toggleDiffs: ["ctrl+t"]
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
  const name = Object.hasOwn(KEY_LABELS, key) ? KEY_LABELS[key] : key.length === 1 ? key.toUpperCase() : key;
  return `${prefix}${name}`;
}

const MODIFIER_LABELS: Readonly<Record<string, string>> = { ctrl: "^", meta: "M-", shift: "S-" };
const KEY_LABELS: Readonly<Record<string, string>> = { return: "Enter", escape: "Esc", pageup: "PgUp", pagedown: "PgDn", tab: "Tab" };

function matchesChord(key: KeyLike, chord: string): boolean {
  const parts = chord.toLowerCase().split("+");
  const name = parts.pop();
  return name === key.name.toLowerCase()
    && parts.includes("ctrl") === key.ctrl
    && parts.includes("meta") === key.meta
    && parts.includes("shift") === key.shift;
}
