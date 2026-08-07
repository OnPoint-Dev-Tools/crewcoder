# CrewCoder TUI Themes

CrewCoder TUI themes are JSON files that override the default dark green/charcoal palette.

## Selecting a theme

Built-ins:

```bash
crewcoder-tui --theme dark
crewcoder-tui --theme light
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
~/.crewcoder/themes/<name>.json
```

Example:

```bash
crewcoder-tui --theme my-theme
```

## Theme format

Custom themes are merged over the built-in `dark` theme, so `colors` may include only the tokens you want to override.

```json
{
  "name": "my-theme",
  "vars": {
    "panel": "#18231f",
    "gold": "#f2b84b"
  },
  "colors": {
    "panel": "panel",
    "accent2": "gold",
    "text": "#e6f3ed"
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

- `dark`, `light`, and `crewcoder` are built-in theme names.
- Invalid theme names or JSON files fail at startup with an error.
- Hot reload is not implemented yet; restart the TUI after editing a theme file.
- Assistant messages intentionally render directly on the transcript background without a panel fill or surrounding border. `panel` and `borderStrong` continue to style operational surfaces.
