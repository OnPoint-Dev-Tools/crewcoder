# termcn components

Footer components come from [termcn](https://www.termcn.dev) (MIT,
[shadcn-labs/termcn](https://github.com/shadcn-labs/termcn)), a shadcn-style registry with
`@opentui/react` variants. As with shadcn, the source is **copied into this package and owned
here**; there is no runtime termcn dependency. Attribution is in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## What is vendored

| File | Registry item | Changes |
|---|---|---|
| `src/components/ui/types.ts` | `opentui/types` | none |
| `src/hooks/use-theme.ts` | `opentui/use-theme` | none |
| `src/hooks/use-motion.ts` | `opentui/use-motion` | none |
| `src/providers/theme-provider.tsx` | `opentui/theme-provider` | none |
| `src/lib/terminal-themes/default.ts` | `opentui/theme-default` | none |
| `src/components/ui/spinner.tsx` | `opentui/spinner` | none |
| `src/hooks/use-animation.ts` | `ink/use-animation` | Ink import and screen-reader check removed (see below) |
| `src/components/ui/tool-call.tsx` | `opentui/tool-call` | see file header |
| `src/components/ui/tool-approval.tsx` | `opentui/tool-approval` | see file header |
| `src/components/ui/alert.tsx` | `opentui/alert` | inline row `flexDirection="row"`; bordered variant sets `border`; fixed one-row body `lines`; trimmed props |
| `src/components/ui/select.tsx` | `opentui/select` | no global keyboard (controlled `active`); renders precomputed wrapped `OptionRow`s from `src/question-model.ts` with indented descriptions; `flexDirection="row"`, height-1 rows; `#666` replaced with theme tokens; rows clickable |
| `src/components/ui/confirm.tsx` | `opentui/confirm` | no global keyboard (upstream answered a bare `y`/`n` from anywhere; controlled `selected`); optional message row; `flexDirection="row"` answer row; answers clickable |
| `src/components/ui/command-palette.tsx` | `opentui/command-palette` | renders a precomputed `PickerView` (filtering/grouping/windowing in `src/palette-model.ts`); keyboard routed by `App`; border title; current-value marker; theme tokens |

Upstream commit: `5a02dae79542add57ba392d2b51785138d0c3b6e`. The slate theme
(`src/theme.ts`) is CrewCoder's own, expressed as termcn `Theme` tokens.

## Upstream problems found and fixed in our copies

- **`tool-approval` approved on a bare `y`.** It registered a global `useKeyboard` for
  `y`/`n`/`a`, so typing a prompt containing "y" while an approval was pending would approve
  the tool call. Our copy has no key handling; `App` routes the configured `approve`/`deny`
  chords (`DEFAULT_APP_KEYBINDINGS`) and passes decision callbacks. It also had an
  auto-deny timer (removed) and defaulted unknown risk to LOW (removed).
- **`tool-call` and `thinking-block` toggle on every Enter/Space** through global
  `useKeyboard`, which fires while typing in the composer. Our `tool-call` takes a controlled
  `collapsed` prop; `thinking-block` is not used.
- **Inline rows collapse in OpenTUI.** Upstream rows are `<box gap={1}>` with no
  `flexDirection`. Ink defaults to row; OpenTUI (Yoga) defaults to column, so side-by-side
  text stacked and vanished inside one-row boxes. Our copies set `flexDirection="row"`.
- **`opentui/spinner` depends on `ink/use-animation`**, which imports `ink`. Our
  `use-animation` is the same hook without the Ink import.
- **`command-palette` owns global keyboard input upstream.** Our copy keeps the
  presentation, but `SessionController` owns query/navigation state and `App` routes palette
  keys through `DEFAULT_APP_KEYBINDINGS`. This avoids competing with the composer and other
  global actions.
- **`command-palette` selected the wrong item with groups.** Upstream draws items grouped
  but indexes the selection in fuzzy-sorted order, so with interleaved groups the
  highlighted row and the selected command differed. It also capped results at 8 with no
  scrolling. `src/palette-model.ts` produces one grouped order for both, and windows long
  lists around the cursor.
- **`alert` draws no border and stacks its title.** Upstream passes `borderColor` and
  `borderStyle` without `border`, and its icon/title row is a `<box gap={1}>` with no
  `flexDirection`. Its body was wrapping `children`, so its height was unknown to the footer
  sizer; ours renders fixed one-row `lines` (`alertRows()` in `src/alert-model.ts`).
- **`select` and `confirm` own global keyboard input upstream**, like `tool-approval`:
  `confirm` answered on a bare `y`/`n` anywhere, and `select` moved and submitted on every
  arrow/Enter even while another field had focus. Our copies are controlled and keyless;
  `App` routes question keys (see `docs/QUESTIONS.md`). Upstream `select` also drew one
  unwrapped row per option, so long labels were cut off.
- `text-input` was evaluated and **not** adopted: it hand-parses keys (no paste, single
  characters only) through a global `useKeyboard`. The composer uses OpenTUI's native
  `<textarea>`.

## Adding another component

`npx shadcn add @termcn/opentui/<name>` writes `@/…` alias imports, which do not resolve in
this package's tsc/NodeNext build (no bundler). Copy components by hand instead:

1. Fetch `https://www.termcn.dev/r/opentui/<name>.json` and its `registryDependencies`.
2. Write each file to its `target` path under `src/`, rewriting `@/x` imports to relative
   `.js` specifiers.
3. Review it before use: remove global `useKeyboard` handlers and hardcoded key names (route
   keys through `DEFAULT_APP_KEYBINDINGS`), set `flexDirection="row"` on inline rows, replace
   hardcoded colors with theme tokens, and check for timers that run when idle.
4. Record the changes in the file header and in the table above, and add tests that render
   it through `@opentui/react/test-utils`.
5. Add any new npm dependency with an exact version.
