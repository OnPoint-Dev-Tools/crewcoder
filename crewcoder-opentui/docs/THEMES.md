# Themes

The OpenTUI UI and the legacy UI read the same themes: the same built-in names, the same
JSON files, the same loader (tui-core `theme/crewcoder-theme`). One file looks the same in
both UIs.

## Selecting a theme

```bash
crewcoder-opentui                       # slate (the default)
crewcoder-opentui --theme dark          # Gotham, the legacy UI's default
crewcoder-opentui --theme light
crewcoder-opentui --theme my-theme      # $CREWCODER_HOME/themes/my-theme.json
crewcoder-opentui --theme ./theme.json  # any file path
CREWCODER_THEME=light crewcoder-opentui
```

Startup order: `--theme`, then `CREWCODER_THEME`, then the theme last picked with `/theme`,
then slate. Built-in names: `slate`, `dark` (alias `crewcoder`), and `light`. Named themes
are looked up in `$CREWCODER_HOME/themes`, then in the shipped examples (`ember`).
`$CREWCODER_HOME` defaults to `~/.crewcoder`.

Through the `crewcoder` umbrella, only `CREWCODER_THEME` works: any argument makes the
launcher forward the call to the agent CLI, so `crewcoder --theme light` never reaches the UI.

An unknown name or an invalid file stops startup with a plain error before the screen
switches, naming the file and the problem:

```txt
crewcoder-opentui: Invalid theme file /home/me/theme.json: Invalid theme hex color: #fff
crewcoder-opentui: Theme not found: nope (built-in themes: dark, crewcoder, light, slate)
```

A saved `/theme` pick that no longer loads (file deleted or broken since) does not stop
startup: the UI opens in slate and shows a warning naming the problem.

## Switching themes: `/theme`

`/theme` (alias `/themes`, also in the `/` palette under Settings) lists every theme:

```txt
Built-in          slate ● (applied), dark, light
Your themes (…)   every <name>.json in $CREWCODER_HOME/themes
Examples          themes shipped with the package (ember)
```

- **Preview:** moving the cursor (or typing to search) shows the highlighted theme on the
  whole screen at once, including code, diffs, and replies already in the transcript.
- **Enter** applies it and saves it to `$CREWCODER_HOME/opentui.json` (`{ "theme": "ember" }`;
  other keys in that file are kept). The alert says so, or says that `--theme` /
  `CREWCODER_THEME` will still win at the next launch while they are set. If saving fails
  (read-only home), the theme still applies for this session and the alert says why.
- **Esc** closes the list and keeps the applied theme.
- `/theme <name|path>` applies directly, through the same path as Enter.
- Unusable files are listed, not hidden, with the reason (`Unusable: Invalid theme file …`,
  or `the built-in light theme takes this name; rename the file`); highlighting one keeps
  the current theme on screen and Enter reports the error. A theme given as a path
  (`--theme ./mine.json`) shows under **Current** so it can be reselected.
- Themes are files on this machine; in `--remote` mode the list is still local (the theme
  belongs to the terminal, not the SSH workspace).

The list is read when `/theme` opens, so a theme file added or edited while the UI runs
shows up the next time you open it (there is no file watcher). The legacy UI does not read
`opentui.json`.

## Theme files

```json
{
  "name": "my-theme",
  "extends": "slate",
  "vars": { "pink": "#ff6fb5", "grey": 245 },
  "colors": { "primary": "pink", "text": "#e6e9ee" },
  "syntax": { "keyword": "pink", "comment": "grey" },
  "markdown": { "heading": "pink", "code": "#9fd8cb" }
}
```

A complete example that sets every token is shipped with the package:
[`examples/themes/ember.json`](../examples/themes/ember.json) (warm charcoal with amber,
coral, sage, and teal). Copy it to `$CREWCODER_HOME/themes/ember.json` and run
`crewcoder-opentui --theme ember`, or pass its path directly. Its test keeps it loading
through the real loader and its colors readable (text 7:1, every other token 3:1).

- `name` (required).
- `extends`: the built-in theme the file is merged over. Defaults to `dark`, as legacy
  files always were; set `"slate"` for a slate variant.
- `vars`: named colors that `colors`, `syntax`, and `markdown` can reference.
- `colors`: the shared color tokens (below). Any subset.
- `syntax`: code highlighting colors (below). Any subset.
- `markdown`: markdown element colors (below). Any subset.

Values are `#rrggbb` hex, 256-color indexes (`0`-`255`), or a `vars` name. Unknown keys
are errors, so typos do not pass silently.

## Color tokens and how OpenTUI uses them

The shared tokens come from the legacy UI. OpenTUI maps them onto termcn's component
tokens in `toAppTheme` (`src/theme.ts`):

| Theme token | OpenTUI use |
| --- | --- |
| `background` | screen background; text on colored chips (`*Foreground`) |
| `backgroundAlt` | diff line-number gutter |
| `text` | body text (`foreground`), selected-row text |
| `muted` | secondary text, reasoning text (`mutedForeground`) |
| `panel` | subtle surfaces (`muted`) |
| `panelAlt` | `secondary` |
| `primary` | headings, user label, links and hints (`info`) |
| `accent` | inline code, targets |
| `success`, `warning`, `danger` | status colors (`danger` is `error`) |
| `border` | borders |
| `borderStrong` | focus ring and focused borders |
| `selectedBg` | highlighted picker row (`selection`) |
| `diffAddBg`, `diffDelBg` | added/removed diff rows; their gutters are lifted 3% toward `text` |

`backgroundAlt` aside, `surface*`, `panelThinking`, `subtle`, `accent2`, `accent3`, and `glow`
are legacy-only today.

## Syntax tokens

Tree-sitter colors for fenced code, inline diffs, and `read` output (see `SYNTAX.md`):

```txt
keyword  string  number  constant  comment  function  type
property  operator  punctuation  tag  attribute  escape
```

Every built-in theme has its own palette (Gotham's uses Gotham's orange, yellow, magenta,
and cyan; `light` uses darker tones for contrast). A file that sets only some syntax
tokens inherits the rest from its `extends` theme. The legacy UI accepts the `syntax`
block but does not use it yet.

## Markdown tokens

Colors for markdown elements, in two places:

- **Replies** (OpenTUI `<markdown>`): rendered, so `#`, `**`, and backticks are hidden.
  Reasoning uses the same tokens, except its headings keep the reasoning text color.
- **Markdown source**: a `read` of a `.md` file, an edit diff of one, and a
  ```` ```markdown ```` fence. Shown exactly as written (markers visible) and highlighted
  with the same colors, so a heading in a file looks like a heading in a reply.

| Token | Element |
| --- | --- |
| `heading` | `#` headings (bold) |
| `strong` | `**bold**` |
| `emphasis` | `*italic*` |
| `strikethrough` | `~~struck~~` |
| `code` | `` `inline code` ``, and fenced code inside markdown source |
| `link` | link text (underlined) |
| `linkUrl` | link targets |
| `listMarker` | `-`, `1.`, task boxes |
| `quote` | `>` block quotes |

Slate's defaults are the colors replies used before these were themeable. The legacy UI
accepts the `markdown` block but does not use it yet.

## Code

- `crewcoder-tui-core/src/theme/crewcoder-theme.ts`: built-ins, file lookup, schema,
  `vars`, 256-color indexes, error messages. Shared with legacy.
- `src/theme.ts`: `toAppTheme` (shared tokens to termcn tokens, diff colors, syntax).
- `src/providers/app-theme-provider.tsx`: `ThemeProvider` (termcn `useTheme`) plus
  `AppColorsContext` (`useAppColors`, diff, syntax, and markdown colors).
- `src/markdown-style.ts`: `markupStyles` (one `markup.*` map for replies and markdown
  source). OpenTUI's `SyntaxStyle` matches a capture's exact name, else only its first
  segment, so every full capture the markdown grammar emits (`markup.raw.block`,
  `markup.list.checked`, ...) is listed; a test reads OpenTUI's queries to keep it complete. Components never import a
  palette directly; they read one of the two hooks.
- `src/theme-controller.ts`: `resolveStartupTheme` (flag > env > saved > slate),
  `fileThemeStore` (`opentui.json`, atomic write), and `ThemeController` (the list,
  `preview`/`endPreview`, `apply`). `SessionController.themes` owns it; picker cursor moves
  call `preview`, `closePicker` calls `endPreview`, and Enter applies before the picker
  closes so the old theme never flashes back.
- `src/Root.tsx` subscribes to the controller and provides `themes.current`, so a switch
  re-themes the whole tree; `useSyntaxStyle` rebuilds native styles when colors change.
- `cli.tsx` resolves the startup theme before `createCliRenderer` and keeps the renderer
  background in step through `themes.onChange`.

Tests: `crewcoder-tui-core/src/tests/crewcoder-theme.test.ts` (built-ins, files, `extends`,
`syntax`, errors), `src/tests/theme.test.ts` (slate unchanged, mapping),
`src/tests/keybindings-args.test.ts` (`--theme`, `CREWCODER_THEME`), and the `app.test.tsx`
syntax tests that render a custom syntax palette, a reply's markdown elements, a read `.md`
file (highlighted, markers kept), and a ```` ```markdown ```` fence.
