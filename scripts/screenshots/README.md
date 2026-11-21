# README screenshots

`npm run screenshots` regenerates the OpenTUI images in `assets/screenshots/` that the
root `README.md` shows.

```sh
npm run build -w @onpoint-dev-tools/crewcoder-opentui
mise exec node@26 -- npm run screenshots
```

## Requirements

- Node.js 26.4 or newer on `PATH` (the OpenTUI floor).
- `tmux` and `resvg`. ImageMagick (`magick`) is optional and only shrinks the PNGs.
- The JetBrains Mono Nerd Font Mono font. Without it, `resvg` falls back to another
  monospace font and the images change.

## How it works

| File | Role |
|---|---|
| `shoot.sh` | Creates a throwaway `HOME` with a small `~/code/todo-api` git project, runs the built `crewcoder-opentui` in a detached tmux session, drives three scenes, and captures each with `tmux capture-pane -e -N`. |
| `demo-agent.mjs` | Stands in for the agent through `CREWCODER_BIN`. It answers `run` and `session resume` with a fixed, realistic event stream (reasoning, read, search, edit, tests, reply, then an approval request) and edits the demo file so the inline diff gets real line numbers. |
| `ansi-to-svg.mjs` | Turns a colored capture into an SVG terminal window. Box and block characters are drawn as shapes so borders and the logo join without gaps. |

The scenes:

| Image | Terminal | Shows |
|---|---|---|
| `opentui-welcome.png` | 118×30 | Welcome screen |
| `opentui-agent-turn.png` | 118×67 | One full turn: reasoning panel, Agent work box, inline diff, markdown reply, status line |
| `opentui-approval-sidebar.png` | 118×42 | Approval card on a follow-up turn, with the sidebar open (Ctrl+B) |

Each height is chosen so the scene fills the window without dead space. If a UI change
moves content, adjust the height in `shoot.sh` and check that the agent turn still starts
with the user's prompt.

Output is deterministic: the same build produces byte-identical PNGs. The fake `HOME`
and `CREWCODER_HOME` keep real paths, sessions, and config out of the images. Scratch
files go to a `crewcoder-shots.*` directory under `$TMPDIR` (default `/tmp`) and are not
deleted by the script.

The images show the real UI replaying a scripted session. The README says so; keep that
note if you change the scenes.
