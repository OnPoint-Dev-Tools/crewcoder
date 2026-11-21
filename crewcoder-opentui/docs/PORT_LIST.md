# Legacy UI -> OpenTUI port list

What the legacy `crewcoder-tui` has that `crewcoder-opentui` still lacks, checked against the
code on 2026-11-18. The branch is not pushed until this list is done.

## Done (removed from the open list)

- Extension UI questions: `ExtensionQuestion` card answers over `resolveUiRequest`.
- Inline diffs for edit/write tools, all providers, real line numbers. Single-column
  (unified) view by owner decision; side-by-side is not planned.
- Ctrl+O expands/collapses tool output; Ctrl+T hides/shows diffs.
- Markdown replies and reasoning (OpenTUI `<markdown>`).
- Mouse: on by default; clicks toggle tool output and diffs, question cards take mouse choices.
- Emoji icons only where the terminal draws them; single-cell icons elsewhere.
- Status line under the composer: access, mode/worker, provider/model (effort), session,
  and context usage with session cost pinned right (`src/status-line.ts`).
- Prompt history: Up/Down recall this session's sent messages and restore the draft
  (`src/prompt-history.ts`).
- `/repaint` (alias `/redraw`): full redraw for a screen garbled by outside output.
- `/quit`, and `/ext.<extension-id>.<command-id> [args]` through `crewcoder command run`.
- Focus gate: keys and pastes are ignored while the terminal is unfocused.
- `CREWCODER_TUI_MOUSE=0` turns mouse reporting off.
- Tree-sitter highlighting for fenced code, inline diffs, and `read` output, with Python,
  Bash, JSON, Rust, Go, YAML, CSS, and HTML grammars bundled in `grammars/` (local files,
  pinned versions and hashes, no runtime downloads). Adds 0.48 MB packed / 3.5 MB
  unpacked. The `/compact preview` editor stays plain (`<textarea>` has no Tree-sitter
  hookup). See `docs/SYNTAX.md`.
- `@` path suggestions under the composer (`docs/MENTIONS.md`). Remote mode lists nothing.
- Composer shortcuts: Ctrl+V clipboard image (else text), dropped/typed image paths,
  Ctrl+X clear images, Ctrl+P palette, Tab/Ctrl+I modes picker. Images go to the agent as
  `--image`; the transcript shows an `IMAGE` row (pixels wait for item 11). See
  `docs/ATTACHMENTS.md`.
- Inline image pixels for sent and tool-result images through OpenTUI's native `<image>`
  (kitty graphics, sixel, half-block fallback; clipped at the transcript edge),
  `CREWCODER_TUI_IMAGE_PROTOCOL`, none in remote mode. See
  `docs/ATTACHMENTS.md#inline-pixels`.
- Assistant throughput: `CREW CODER 42.3 tok/s` once `message_end` reports timing. The
  agent now times generation only (`GenerationClock`): tool runs, approvals, and questions
  inside Claude/Codex calls no longer count, so the rate is real on native providers too
  (legacy shows the same corrected number). Formatting is shared in tui-core
  `state/usage` (`formatTokensPerSecond`).
- Right sidebar: modified files, live crew agents, crew tasks, `<cwd>:<git>` footer,
  `/sidebar`, `/file-changes`, Ctrl+B, draggable divider. Task store reader shared with
  legacy through tui-core `state/crew-tasks`. See `docs/SIDEBAR.md`.
- Remote target in state: `--remote` sets `state.remoteTarget` and the remote `state.cwd`,
  so the welcome screen and sidebar footer show `<target>:<cwd>`.
- Branching from `/sessions`: Tab branches the highlighted session and opens the branch
  (its history and saved settings); `/branch <id>` does the same by id. Legacy's `b` only
  switched `state.sessionId` and left the old conversation on screen; this loads the
  branch. See `docs/COMMAND_PALETTE.md`.
- Themes: `--theme`, `CREWCODER_THEME`, built-ins `slate` (default), `dark` (Gotham),
  `light`, and custom JSON themes shared with legacy (loader moved to tui-core
  `theme/crewcoder-theme`). Theme files can set syntax and markdown element colors
  (`syntax`, `markdown` blocks) and pick their base (`extends`); `.md` reads are
  highlighted with the same colors. Example: `examples/themes/ember.json`. `/theme` lists
  every theme with a live preview, applies on Enter, and remembers the pick
  (`$CREWCODER_HOME/opentui.json`). See `docs/THEMES.md`.
- Status panels in the transcript (`src/block-panels.ts`): background jobs, plugin
  validation, crew rosters, goals, review summaries, `/why`, checkpoints. Scoped by owner
  decision (2026-11-19): `/goal`, `/review-summary`, `/why` stay footer alerts; the panels
  cover blocks the event stream delivers. The placeholders users actually hit were
  background jobs and validation. See `docs/TRANSCRIPT.md#status-panels`.
- Live crews (2026-11-20): `/crew` and `/team` stream through the bridge; worker-labelled
  transcript, AGENTS roster, workers' tasks in the sidebar, approvals answered from the UI
  (the agent's crew commands now attach the stdin control channel; review-mode crews used
  to auto-deny every gated tool, in legacy too). With tmux, a crew can run in a second UI
  in tmux that survives closing this one (`docs/CREWS.md#tmux`). See `docs/CREWS.md`.
- User messages show a filled `●` (theme primary) left of the text instead of a `YOU` row.
- Logo color pulse (2026-11-20): the welcome wordmark breathes from `accent` at half
  brightness to `glow` (legacy timing: 2.2 s breath, frozen after 3 minutes without a key),
  steady on `glow` under `NO_MOTION=1`/`CI=true` (`src/logo-pulse.ts`, `PulsingLogo`).
- Transcript search (2026-11-20): Ctrl+F / `/find [text]`, newest match first, jumps to the
  exact wrapped line (expanding collapsed output) and marks it; the bar shows the match line.
  No in-text highlight by owner decision (OpenTUI only allows it through internals). See
  `docs/TRANSCRIPT.md#search`.
- tmux support (2026-11-20, owner request): audited with an attached client; startup note
  for missing tmux settings and an honest copy message. See `docs/TMUX.md`.

## Open

1. ~~**Prompt history.**~~ Done.
2. ~~**`@` path suggestions**~~ Done.
3. ~~**Composer shortcuts**~~ Done (Ctrl+B with the sidebar).
4. ~~**Slash commands:** `/repaint`, `/redraw`, `/quit`, `/ext.<name>`.~~ Done.
5. ~~**Terminal focus reporting** and **`CREWCODER_TUI_MOUSE`**.~~ Done.
6. ~~**Tree-sitter syntax highlighting.**~~ Done (`docs/SYNTAX.md`).
7. ~~**Right sidebar**~~ Done (`docs/SIDEBAR.md`).
8. ~~**Branching from `/sessions`.**~~ Done.
9. ~~**Themes**~~ Done (`docs/THEMES.md`).
10. ~~**Image attachments and terminal graphics**, including tool-result images.~~ Done.
11. ~~**Assistant throughput metadata.**~~ Done.
12. ~~**Live UI** (sandboxed extension workers).~~ Skipped by owner decision (2026-11-19).
13. ~~**Dedicated crew, goal, and review-summary views.**~~ Done (status panels).
14. ~~**Logo color pulse.**~~ Done.
15. ~~**Transcript search.**~~ Done.

16. ~~**Remote target in state.**~~ Done with the sidebar (`cli.tsx`).

Skipped by owner decision: Live UI (`contributes.liveUi[]`). (`/crew` was skipped too, then
ported with live crews by owner decision on 2026-11-20.) Live UI is
experimental, off by default (`allowExtensionLiveUi=false`), used by no known extension,
and unfinished in legacy (no real-worker end-to-end tests, uncolored text frames). Legacy
`crewcoder-tui` keeps it. Declarative extension components and questions still work here.

## Order

1. ~~Status line with context usage and cost.~~ Done.
2. ~~Prompt history.~~ Done.
3. ~~`/repaint`, `/quit`, `/ext.*`, focus reporting, `CREWCODER_TUI_MOUSE`.~~ Done.
4. ~~Tree-sitter highlighting.~~ Done.
5. ~~`@` paths and composer shortcuts.~~ Done.
6. ~~Right sidebar, then `/sessions` branching.~~ Done.
7. ~~Themes.~~ Done.
8. ~~Images, throughput.~~ Done.
9. ~~Dedicated views, logo pulse.~~ Done. (Live UI skipped.)
10. ~~Transcript search (moved to the end by owner decision).~~ Done.
