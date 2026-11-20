# Syntax highlighting

The transcript highlights code with OpenTUI's Tree-sitter client (a parser worker that
runs web-tree-sitter 0.25.10). Highlighting never blocks a render: text draws plain first
and takes its colors when the worker answers.

## Where it applies

| Surface | Filetype from | Renderer |
|---|---|---|
| Fenced code in replies and reasoning | the fence's info string (`infoStringToFiletype`) | `<markdown>`'s default code block, behind a left rail (`codeFence`) |
| Inline diffs with real line numbers | the edited path (`codeFiletype`) | `<diff filetype syntaxStyle>` |
| `read` tool output | the read path (`readOutputFiletype`) | `<code>` in a padded box |

These stay plain on purpose:

- Unanchored snippet diffs. They are tinted `+`/`-` text lines, not `<diff>`.
- Read output whose lines start with line numbers (Claude Code's `     1→`, `cat -n`).
  A parser would read the prefixes as code.
- Failed tools, command output, and search results.
- The `/compact preview` summary editor. OpenTUI's `<textarea>` has no Tree-sitter hookup.

## Languages

| Bundled by OpenTUI 0.9.2 | Bundled here (`grammars/`) |
|---|---|
| JavaScript, JSX, TypeScript, TSX, Markdown, Zig | Python, Bash, JSON, Rust, Go, YAML, CSS, HTML |

Any other language renders as plain text. `codeFiletype` returns no filetype for
languages without a parser, so diffs and reads never send them to the worker. A fence in
an unknown language goes to the worker, which answers "no parser" and leaves it plain.

## Bundled grammars

Owner decision (2026-11-18): bundle the grammars in this package and never download them
at runtime. They work offline, run no downloaded code, and cost nothing on headless
installs (this package is an optional dependency of the umbrella).

- Each language comes from its own npm package at an exact version: the compiled `.wasm`,
  the package's `queries/highlights.scm`, and its LICENSE. Using the grammar's own query
  matters: a query that names a node the grammar lacks fails to compile and turns
  highlighting off for that language. OpenTUI's defaults use nvim-treesitter `master`
  queries, which can drift from a pinned grammar.
- `src/syntax/grammars.ts` lists filetype, package, version, and the SHA-256 of the wasm
  and query. `src/tests/grammars.test.ts` checks the hashes, the licenses, and that every
  grammar loads and highlights in the real worker.
- `registerBundledGrammars()` runs in `cli.tsx` before the first render. It passes
  absolute paths inside the package to `addDefaultParsers`. OpenTUI resolves relative
  paths against the process cwd and fetches URLs with no integrity check, so neither is
  ever used. A missing grammar directory is skipped (plain text, never a failed render).
- Injection queries (HTML `<script>`/`<style>`, Rust doc comments) are not bundled.
- Size: the grammars add about 3.5 MB unpacked and 0.48 MB to the npm tarball (measured
  2026-11-19: 240 KB to 723 KB packed, 0.9 MB to 4.4 MB unpacked).

### Updating a grammar

1. Change the version in `scripts/update-grammars.mjs` and `BUNDLED_GRAMMARS`.
2. `node scripts/update-grammars.mjs`. It runs `npm pack --ignore-scripts` in a temp
   directory, copies the three files, and prints the new hashes.
3. Paste the hashes into `BUNDLED_GRAMMARS`, update `THIRD_PARTY_NOTICES.md`, and run the
   tests (`grammars.test.ts` proves the new grammar loads and its query compiles).

## Colors

Colors come from the active theme's `syntax` palette (`useAppColors().syntax`; every
built-in has one, and theme files can override any token; see `THEMES.md`). Markdown
source (`.md` reads and diffs, ```` ```markdown ```` fences) uses OpenTUI's markdown
grammar and the theme's `markdown` colors through `markupStyles`. Read output is never
concealed (`<code conceal={false}>`; OpenTUI conceals by default), so `# Title` and
`**bold**` show exactly as in the file.
`codeStyles(syntax)` (`src/markdown-style.ts`) maps capture names to them. OpenTUI resolves a
dotted capture to its first segment (`function.method` to `function`), so base names
cover most captures. Variables keep the surrounding text color.

## Tests

The test renderer tears down OpenTUI's shared Tree-sitter client when the last renderer is
destroyed. A highlight still initializing at that moment logs `Code highlighting failed,
falling back to plain text` to stderr. That is test teardown, not a failure. The app keeps
one renderer until it quits.
