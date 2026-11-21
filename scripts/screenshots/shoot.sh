#!/usr/bin/env bash
# Regenerate the README screenshots of the OpenTUI UI.
#
# Runs the built crewcoder-opentui in a detached tmux session against the scripted
# demo agent (demo-agent.mjs), captures three scenes with colors, converts them to
# SVG (ansi-to-svg.mjs), and renders 2x PNGs into assets/screenshots/.
#
# Requires: Node.js >=26.4 on PATH, tmux, resvg; ImageMagick (magick) is optional
# and only used to shrink the PNGs. Build the UI first:
#   npm run build -w @onpoint-dev-tools/crewcoder-opentui
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT_DIR="$ROOT/assets/screenshots"
CLI="$ROOT/crewcoder-opentui/dist/cli.js"
COLS=118
BG="#101216" # slate theme background, for cells the UI leaves unpainted
TITLE="crewcoder — ~/code/todo-api"
SOCKET="crewcoder-shots-$$"
T=(tmux -L "$SOCKET")

for tool in tmux resvg node; do
  command -v "$tool" >/dev/null || { echo "shoot.sh: $tool is required" >&2; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>26||(a===26&&b>=4)?0:1)' \
  || { echo "shoot.sh: Node.js >=26.4 is required (found $(node --version)); try: mise exec node@26 -- $0" >&2; exit 1; }
[ -f "$CLI" ] || { echo "shoot.sh: $CLI is missing; run npm run build -w @onpoint-dev-tools/crewcoder-opentui" >&2; exit 1; }

# Scratch files stay in a temp directory (nothing is deleted recursively); the
# system temp cleanup reclaims it.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/crewcoder-shots.XXXXXX")"
trap '"${T[@]}" kill-server 2>/dev/null || true' EXIT

make_project() {
  mkdir -p "$PROJECT/src/routes"
  cat > "$PROJECT/package.json" <<'EOF'
{ "name": "todo-api", "version": "1.4.0", "type": "module", "scripts": { "test": "vitest run" } }
EOF
  cat > "$PROJECT/src/routes/todos.ts" <<'EOF'
import { Router } from "express";
import { listTodos } from "../store.js";

export const todos = Router();

todos.get("/", async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 20);
  const items = await listTodos({ offset: (page - 1) * limit, limit });
  res.json({ page, limit, items });
});
EOF
  echo 'import { describe, expect, it } from "vitest";' > "$PROJECT/src/routes/todos.test.ts"
  git -C "$PROJECT" init -q -b feature/pagination
  git -C "$PROJECT" add -A
  git -C "$PROJECT" -c user.name=demo -c user.email=demo@example.com -c core.hooksPath=/dev/null commit -qm init
}

wait_for() { # <text> [timeout seconds]
  local deadline=$((SECONDS + ${2:-20}))
  until "${T[@]}" capture-pane -p | grep -qF -- "$1"; do
    (( SECONDS < deadline )) || { echo "shoot.sh: timed out waiting for: $1" >&2; exit 1; }
    sleep 0.3
  done
}

start_ui() { # <scene> <rows>
  "${T[@]}" kill-server 2>/dev/null || true
  # Each scene gets a fresh project and state. A throwaway HOME keeps real paths,
  # sessions, and config out of the images.
  FAKE_HOME="$WORK/$1/home"
  PROJECT="$FAKE_HOME/code/todo-api"
  make_project
  mkdir -p "$WORK/$1/crewcoder-home"
  "${T[@]}" -f /dev/null new-session -d -x "$COLS" -y "$2" -c "$PROJECT" -e COLORTERM=truecolor -e TERM=tmux-256color \
    "env HOME='$FAKE_HOME' PATH='$PATH' CREWCODER_BIN='$HERE/demo-agent.mjs' CREWCODER_HOME='$WORK/$1/crewcoder-home' \
      CREWCODER_PROVIDER=claude CREWCODER_MODEL=claude-opus-5-5 CREWCODER_TUI_TMUX_HINT=0 NO_MOTION=1 \
      node --disable-warning=ExperimentalWarning '$CLI'; exec sleep 600"
  wait_for "█"
  sleep 1.5
}

send() { "${T[@]}" send-keys -l "$1"; sleep 0.4; "${T[@]}" send-keys Enter; }

capture() { # <name>
  # -N keeps trailing cells so panel backgrounds reach the row end.
  "${T[@]}" capture-pane -e -N -p > "$WORK/$1.ansi"
  COLS="$COLS" BG="$BG" node "$HERE/ansi-to-svg.mjs" "$WORK/$1.ansi" "$WORK/$1.svg" "$TITLE" >/dev/null
  resvg --zoom 2 "$WORK/$1.svg" "$WORK/$1.png" 2>/dev/null
  mkdir -p "$OUT_DIR"
  if command -v magick >/dev/null; then magick "$WORK/$1.png" -strip -define png:compression-level=9 "$OUT_DIR/$1.png"
  else cp "$WORK/$1.png" "$OUT_DIR/$1.png"; fi
  echo "wrote assets/screenshots/$1.png"
}

# Heights are chosen so each scene fills the window without dead space.
start_ui welcome 30
capture opentui-welcome

start_ui turn 67
send "Bound the page and limit query params on GET /todos and add tests"
wait_for "All 6 tests"; sleep 2
capture opentui-agent-turn

start_ui approval 42
send "Bound the page and limit query params on GET /todos and add tests"
wait_for "All 6 tests"; sleep 1
send "Looks good, commit it"
wait_for "Approve"; sleep 1
"${T[@]}" send-keys C-b; sleep 1.5
capture opentui-approval-sidebar
