/**
 * Theme the whole terminal, not just the footer. In split-footer mode the
 * transcript lives in the terminal's native scrollback, which OpenTUI does not
 * paint, so it would show the terminal's default background. Like the legacy
 * UI, set the terminal's default background with OSC 11 while running and
 * restore it with OSC 111 on exit.
 *
 * Write these outside the renderer's lifetime: in `capture-stdout` mode,
 * stdout writes made while it runs become plain scrollback text.
 */
export type TerminalWriter = { write(chunk: string): unknown };

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Returns the reset function, which is safe to call more than once. */
export function applyTerminalBackground(out: TerminalWriter, color: string): () => void {
  // Only a plain #rrggbb may reach an escape sequence; anything else could
  // inject terminal controls once themes become user-configurable.
  if (!HEX_COLOR.test(color)) return () => {};
  out.write(`\x1b]11;${color}\x07`);
  let reset = false;
  return () => {
    if (reset) return;
    reset = true;
    out.write("\x1b]111\x07");
  };
}
