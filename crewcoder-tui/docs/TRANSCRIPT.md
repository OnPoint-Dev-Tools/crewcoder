# Conversation transcript

CrewCoder conversation view writes settled messages into the terminal's own
scrollback and only rewrites the live tail (the current streaming block, the
working indicator, and the composer).

That is implemented now. It is not a second CrewCoder-owned pager that happens
to look like the terminal.

## Why

The previous transcript was a private viewport: every 120ms the TUI laid out
the entire history, sliced a window, and painted the full screen with cursor
addressing. After a few messages and tool calls that froze input and made
in-app scrolling lag. Native Ghostty/Kitty/xterm scroll showed the shell
session from *before* CrewCoder started, because the TUI was overwriting the
visible screen in place.

## Behavior

- Settled user, assistant, thinking, and completed tool blocks are printed
  once and then left in the terminal history. Scroll with the terminal
  (trackpad, scrollbar, Shift+PageUp).
- Streaming text, running tools, the working indicator, and the composer stay
  in a live region at the bottom of the output. Those lines are rewritten in
  place and bounded to the available terminal height.
- Mouse reporting is off in this mode so the terminal can own wheel/selection.
  Native copy works on committed transcript text.
- Home, modal overlays, the right sidebar, and Live UI surfaces still use the
  full-screen TUI. They show the latest transcript snapshot; closing them
  returns to the same committed native terminal history.
- `/repaint` (alias `/redraw`) clears terminal scrollback and reprints the
  settled transcript. Use it after a resize artifact.

## Limitations

- New output (streaming tokens, spinner ticks) typically jumps the terminal
  back to the bottom. Read history after the turn settles, or while the live
  tail is quiet.
- When you native-scroll up, the composer scrolls away with the rest of the
  buffer. That is the terminal's viewport, not a pinned overlay.
- Inline images in already-committed blocks are not re-drawn in scrollback;
  the text path/caption remains.
- A 120ms timer still runs so the spinner and home logo can animate. It no
  longer re-highlights or repaints settled history: block layout is cached
  until that block's content, width, or expansion state changes, and the
  renderer paints only newly committed rows.
