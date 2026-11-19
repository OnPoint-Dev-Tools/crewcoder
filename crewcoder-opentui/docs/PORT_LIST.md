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

## Open

1. **Transcript search.** Terminal search cannot see the alternate screen.
2. ~~**Prompt history.**~~ Done.
3. **`@` path suggestions** in the composer (legacy `path-suggestions.ts`).
4. **Composer shortcuts:** Ctrl+V image paste (and dropped image paths), Ctrl+X clear
   attachments, Ctrl+P palette, Ctrl+I agents overlay, Ctrl+B sidebar.
5. ~~**Slash commands:** `/repaint`, `/redraw`, `/quit`, `/ext.<name>`.~~ Done.
6. ~~**Terminal focus reporting** and **`CREWCODER_TUI_MOUSE`**.~~ Done.
7. **Tree-sitter syntax highlighting.** OpenTUI has a Tree-sitter client (`<code>`,
   `<markdown>`, and `<diff>` accept `treeSitterClient`/`filetype`/`syntaxStyle`) and
   `pathToFiletype`/`infoStringToFiletype` helpers. Use it for:
   - fenced code blocks in replies and reasoning (`infoStringToFiletype` on the fence);
   - inline diffs (`filetype` from the edited path);
   - `read` tool output (`pathToFiletype` on the read path);
   - `/compact preview` summary and other markdown surfaces, for consistency.
   OpenTUI ships grammars for JavaScript, TypeScript, TSX, Markdown, and Zig only.
   **Owner decision (2026-11-18): bundle extra grammars in this package; no runtime
   downloads.** Add Python, Bash, JSON, Rust, Go, YAML, CSS, and HTML (about 5-8 MB of
   `.wasm` + highlight queries), registered with `addDefaultParsers` from local package
   paths. Rationale: works offline, no network access or downloaded code at runtime, and
   headless installs never pay for it (this package is an optional dependency).
   Implementation notes:
   - Pin each grammar to an exact source version and record it (with its license) in
     `THIRD_PARTY_NOTICES.md`; include the files in the package `files` list.
   - Never point a parser at a URL; OpenTUI's loader has no integrity check.
   - Unknown or unbundled filetypes fall back to plain text and never fail the render.
   - Measure the real package size increase and report it before publishing.
8. **Right sidebar:** file changes, live crew agents, crew tasks, cwd:git footer; unblocks
   `/sidebar` and `/file-changes`.
9. **Branching from `/sessions`.**
10. **Themes:** `--theme`, `CREWCODER_THEME`, custom JSON themes.
11. **Image attachments and terminal graphics**, including tool-result images.
12. **Live UI** (sandboxed extension workers).
13. **Assistant throughput metadata.**
14. **Dedicated crew, goal, and review-summary views** (one-line placeholders today).
15. **Logo color pulse.**

16. **Remote target in state.** OpenTUI never sets `state.remoteTarget` (legacy sets it in
    `tui.ts` from the resolved remote connection), so `--remote` shows the local folder on
    the welcome screen instead of `<host>:<path>`, and `state.cwd` is the local directory.
    Wire it from the bridge's remote connection; the status-line repo name stays off in
    remote mode.

Skipped by owner decision: `/crew`.

## Order

1. ~~Status line with context usage and cost.~~ Done.
2. ~~Prompt history.~~ Done.
3. ~~`/repaint`, `/quit`, `/ext.*`, focus reporting, `CREWCODER_TUI_MOUSE`.~~ Done.
4. Tree-sitter highlighting.
5. `@` paths and composer shortcuts.
6. Right sidebar, then `/sessions` branching.
7. Transcript search.
8. Images, themes, Live UI, throughput, dedicated views, logo pulse.
