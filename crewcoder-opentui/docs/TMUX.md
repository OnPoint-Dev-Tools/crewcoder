# Running under tmux

OpenTUI works inside tmux, but four tmux defaults break things. CrewCoder checks them at
startup and lists what is missing (`src/tmux-check.ts`):

```txt
⚠ tmux: 4 settings missing for CrewCoder
• Mouse-select copy never reaches your clipboard
• Shift+Enter sends instead of adding a line (Ctrl+J still adds one)
• CrewCoder cannot tell when this pane is in the background
• Theme colors are reduced to 256 colors
```

## Recommended `~/.tmux.conf`

```tmux
set -g set-clipboard on                    # let programs copy to the system clipboard
set -g extended-keys on                    # deliver Shift+Enter (and other modified keys)
set -g focus-events on                     # tell programs when the pane gains/loses focus
set -as terminal-features ',xterm*:RGB'    # 24-bit color (Ghostty's TERM is xterm-ghostty)
```

Apply with `tmux source-file ~/.tmux.conf`. The `terminal-features` line takes effect when
a client attaches, so detach and reattach once. Hide the startup note with
`CREWCODER_TUI_TMUX_HINT=0`.

## What was measured

Checked on tmux 3.8 with a real attached client: a pty harness played the outer terminal,
fed it keys and SGR mouse input, and recorded what tmux sent back out.

| Area | tmux defaults | With the settings above |
| --- | --- | --- |
| Shift+Enter | arrives as Enter: the message is **sent** | newline (`extended-keys` with `xterm` or `csi-u` format both work) |
| Ctrl+J | newline | newline |
| Mouse (click, drag, wheel) | works: tmux turns on SGR mouse in the outer terminal | works |
| Copy on mouse select | clipboard write dropped (`set-clipboard external`); the UI used to say "Copied" anyway | reaches the terminal (OSC 52) |
| Focus gate | no focus events: the gate never blurs (input is never dropped) | unfocused panes drop keys and pastes, as designed |
| Colors | 24-bit theme colors reduced to 256 | 24-bit |
| Icons | single-cell set (OpenTUI reports `multiplexer: tmux`) | same |
| Inline images | half-block cells (OpenTUI's `auto` mode never uses kitty graphics in tmux) | same |
| Resize | redraws cleanly | same |
| Esc | immediate (`escape-time` is 10 ms in tmux 3.5+; older tmux defaults to 500 ms: `set -sg escape-time 10`) | same |

Not verified here: that a given outer terminal (Ghostty, kitty, ...) sends modified keys
once tmux asks for them. The harness sent the bytes those terminals send.

## What CrewCoder does

- **Startup note** (`readTmuxSettings`, `tmuxIssues`, `tmuxSettingsAlert`): inside tmux
  (`$TMUX`), read `set-clipboard`, `extended-keys`, `focus-events` (server scope, then
  global) and the attached client's `#{client_termfeatures}`, and show one warning alert
  with the lines to add. Nothing is shown when everything is set, when a value cannot be
  read, or with `CREWCODER_TUI_TMUX_HINT=0`. An empty feature list (no client attached
  yet) counts as unknown, never as "no RGB".
- **Honest copy** (`copyAlert`): after a mouse selection, `set-clipboard` is read again
  (so fixing tmux.conf works without restarting CrewCoder). Unless it is `on`, the alert
  says the text was not copied and how to fix it, instead of "Copied N characters".
- Icons and images already fall back inside tmux (see `docs/TRANSCRIPT.md#icons` and
  `docs/ATTACHMENTS.md`). Do not force `CREWCODER_TUI_IMAGE_PROTOCOL=kitty` inside tmux:
  OpenTUI does not wrap kitty graphics for tmux passthrough.
- Crews can run in tmux and outlive this UI: see `docs/CREWS.md#tmux`.

## Tests

`src/tests/tmux-check.test.ts`: each default maps to its fix, `always` counts as on,
unreadable values stay quiet, the alert text, and copy never claims success when tmux
drops it.

To reproduce the measurements, start OpenTUI in `tmux -L <socket> -f <conf> new-session -d`,
attach a client from a pty you control (Python `pty.fork` running `tmux attach`), write the
outer terminal's bytes (for example `\e[27;2;13~` for Shift+Enter, `\e[<0;x;yM` for mouse),
and search the client's output for `\e]52;` (clipboard), `\e[?1004h` (focus), and `38;2;`
(24-bit color). A detached session never sends focus events and has no client features,
so checks there prove nothing about focus or color.
