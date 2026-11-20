# CrewCoder TUI Themes

CrewCoder TUI themes are JSON files that override the default dark green/charcoal palette.
The loader and built-ins live in `@onpoint-dev-tools/crewcoder-tui-core/theme/crewcoder-theme`
and are shared with the OpenTUI UI, so the same names and files work in both (see
`crewcoder-opentui/docs/THEMES.md` for how OpenTUI maps the tokens).

## Selecting a theme

Built-ins:

```bash
crewcoder-tui --theme dark
crewcoder-tui --theme light
crewcoder-tui --theme slate   # the OpenTUI UI's default palette
```

Environment variable:

```bash
CREWCODER_THEME=light crewcoder-tui
```

Theme file path:

```bash
crewcoder-tui --theme ~/.crewcoder/themes/my-theme.json
```

Named custom themes are loaded from:

```txt
$CREWCODER_HOME/themes/<name>.json   (CREWCODER_HOME defaults to ~/.crewcoder)
```

Example:

```bash
crewcoder-tui --theme my-theme
```

## Theme format

Custom themes are merged over the built-in `dark` theme, or over the built-in named in
`extends`, so `colors` may include only the tokens you want to override. The optional
`syntax` block sets code highlighting colors (`keyword`, `string`, `number`, `constant`,
`comment`, `function`, `type`, `property`, `operator`, `punctuation`, `tag`, `attribute`,
`escape`), and the optional `markdown` block sets markdown element colors (`heading`,
`strong`, `emphasis`, `strikethrough`, `code`, `link`, `linkUrl`, `listMarker`, `quote`). The
OpenTUI UI uses both; this UI accepts them but does not use them yet. A full example that
sets every token is `crewcoder-opentui/examples/themes/ember.json`.

```json
{
  "name": "my-theme",
  "extends": "dark",
  "vars": {
    "panel": "#18231f",
    "gold": "#f2b84b"
  },
  "colors": {
    "panel": "panel",
    "accent2": "gold",
    "text": "#e6f3ed"
  },
  "syntax": {
    "keyword": "gold"
  }
}
```

Color values support:

- Hex colors: `"#72dfcf"`
- 256-color indexes: `236`
- Variable references from `vars`: `"gold"`

## Tokens

```txt
background
backgroundAlt
surface
surfaceAlt
surfaceGlow
panel
panelAlt
panelThinking
selectedBg
diffAddBg
diffDelBg
border
borderStrong
primary
text
muted
subtle
success
warning
danger
accent
accent2
accent3
glow
```

## Notes

- `dark`, `light`, `crewcoder`, and `slate` are built-in theme names. `dark` stays the default here.
- Invalid theme names or JSON files fail at startup with an error that names the file and the problem; unknown keys are errors.
- Hot reload is not implemented yet; restart the TUI after editing a theme file.
- Assistant messages intentionally render directly on the transcript background without a panel fill or surrounding border. `panel` and `borderStrong` continue to style operational surfaces.
