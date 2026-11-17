import type { TextareaRenderable } from "@opentui/core";
import type { ReactNode, RefObject } from "react";
import { composerRows, wrappedLineCount } from "../footer-layout.js";
import { useTheme } from "../hooks/use-theme.js";
import { textareaBindings } from "../keybindings.js";

/** Enter submits; Shift+Enter / Ctrl+J insert a newline (DEFAULT_APP_KEYBINDINGS). */
const COMPOSER_BINDINGS = textareaBindings({ composerSubmit: "submit", composerNewline: "newline" } as const);

export type ComposerProps = {
  inputRef: RefObject<TextareaRenderable | null>;
  lines: number;
  placeholder: string;
  /** Visual line count changed (the footer is resized from it). */
  onLines: (lines: number) => void;
  /** The text changed; kept so a draft survives an overlay that unmounts the composer. */
  onText: (text: string) => void;
  /** "/" typed into an empty composer. */
  onSlash: () => void;
  onSubmit: (text: string) => void;
};

/**
 * Multi-line composer on OpenTUI's `<textarea>`. Uncontrolled: callers read and
 * clear it through `inputRef`. It grows with its wrapped content up to
 * MAX_COMPOSER_LINES, then scrolls.
 */
export function Composer({ inputRef, lines, placeholder, onLines, onText, onSlash, onSubmit }: ComposerProps): ReactNode {
  const theme = useTheme();
  const rows = composerRows(lines);
  return (
    <box border borderStyle="rounded" borderColor={theme.border.color} height={rows} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <textarea
        ref={inputRef}
        focused
        height={rows - 2}
        wrapMode="word"
        placeholder={placeholder}
        placeholderColor={theme.colors.mutedForeground}
        textColor={theme.colors.foreground}
        focusedTextColor={theme.colors.foreground}
        keyBindings={COMPOSER_BINDINGS}
        onContentChange={() => {
          const input = inputRef.current;
          if (!input) return;
          if (input.plainText === "/") {
            input.setText("");
            onSlash();
            return;
          }
          onText(input.plainText);
          onLines(wrappedLineCount(input.plainText, input.width));
        }}
        onSubmit={() => {
          const input = inputRef.current;
          if (input) onSubmit(input.plainText);
        }}
      />
    </box>
  );
}
