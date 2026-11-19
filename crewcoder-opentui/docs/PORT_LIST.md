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
- Right sidebar: modified files, live crew agents, crew tasks, `<cwd>:<git>` footer,
  `/sidebar`, `/file-changes`, Ctrl+B, draggable divider. Task store reader shared with
  legacy through tui-core `state/crew-tasks`. See `docs/SIDEBAR.md`.
- Remote target in state: `--remote` sets `state.remoteTarget` and the remote `state.cwd`,
  so the welcome screen and sidebar footer show `<target>:<cwd>`.
- Branching from `/sessions`: Tab branches the highlighted session and opens the branch
  (its history and saved settings); `/branch <id>` does the same by id. Legacy's `b` only
  switched `state.sessionId` and left the old conversation on screen; this loads the
  branch. See `docs/COMMAND_PALETTE.md`.

## Open

1. **Transcript search.** Terminal search cannot see the alternate screen.
2. ~~**Prompt history.**~~ Done.
3. ~~**`@` path suggestions**~~ Done.
4. ~~**Composer shortcuts**~~ Done (Ctrl+B with the sidebar).
5. ~~**Slash commands:** `/repaint`, `/redraw`, `/quit`, `/ext.<name>`.~~ Done.
6. ~~**Terminal focus reporting** and **`CREWCODER_TUI_MOUSE`**.~~ Done.
7. ~~**Tree-sitter syntax highlighting.**~~ Done (`docs/SYNTAX.md`).
8. ~~**Right sidebar**~~ Done (`docs/SIDEBAR.md`).
9. ~~**Branching from `/sessions`.**~~ Done.
10. **Themes:** `--theme`, `CREWCODER_THEME`, custom JSON themes.
11. **Image attachments and terminal graphics**, including tool-result images.
12. **Live UI** (sandboxed extension workers).
13. **Assistant throughput metadata.**
14. **Dedicated crew, goal, and review-summary views** (one-line placeholders today).
15. **Logo color pulse.**

16. ~~**Remote target in state.**~~ Done with the sidebar (`cli.tsx`).

Skipped by owner decision: `/crew`.

## Order

1. ~~Status line with context usage and cost.~~ Done.
2. ~~Prompt history.~~ Done.
3. ~~`/repaint`, `/quit`, `/ext.*`, focus reporting, `CREWCODER_TUI_MOUSE`.~~ Done.
4. ~~Tree-sitter highlighting.~~ Done.
5. ~~`@` paths and composer shortcuts.~~ Done.
6. ~~Right sidebar, then `/sessions` branching.~~ Done.
7. Transcript search.
8. Images, themes, Live UI, throughput, dedicated views, logo pulse.
