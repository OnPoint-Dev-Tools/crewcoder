# `@` path suggestions

Typing `@` at the start of a word in the composer lists workspace files and folders under
the composer, ported from the legacy UI's "Attach file or folder" popover
(`crewcoder-tui/src/components/path-suggestions.ts`). Picking one writes `@<path>` into the
prompt. The agent reads it as ordinary prompt text; nothing is attached or uploaded.

## Behavior

- A token is `@` after whitespace (or at the start) followed by path characters
  (`A-Z a-z 0-9 . _ / \ -`). `user@host` never triggers it.
- Matching and walking follow legacy: a path prefix, any segment prefix, or the file
  name prefix, case-insensitive; directories first at each level; `.git`, `node_modules`,
  `dist`, `build`, `.next`, `.turbo`, `coverage`, `.cache`, `.crewcoder` skipped; at most
  50 results, 1,500 entries visited, 7 levels deep.
- The list shows up to 8 rows (`MENTION_ROWS`) and scrolls with the highlight. With no
  match it shows `No matching paths`.
- Picking a file inserts `@path ` (with a trailing space). Picking a directory inserts
  `@dir/` with no space, so its contents are suggested next. This differs from legacy on
  purpose.
- Listing is async. An answer for a token the user has already left is dropped, and the
  previous list stays up until the new one arrives, so typing does not flicker.
- Remote mode (`--remote`) never lists paths: the workspace is on the SSH host, and the
  local disk must not stand in for it (legacy rule).

## Keys

| Action | Default | Notes |
|---|---|---|
| `mentionUp` / `mentionDown` | Up / Down | wraps around; takes precedence over prompt history |
| `mentionSelect` | Enter, Tab | Enter with no matches sends the prompt as usual |
| `mentionClose` | Esc | closes the list without aborting a run; it reopens when the token changes |

The composer keeps focus throughout. `App.handleMentionKey` runs before transcript keys,
history, and abort, and calls `preventDefault` so the textarea does not also take the key.

## Cursor units

OpenTUI 0.9.2's `<textarea>` `cursorOffset` counts display cells, not UTF-16 units:
`😀` and `中` count 2, a combining accent 0, a newline 1, a tab 2. `src/text-offset.ts`
converts both ways (`offsetToIndex`, `indexToOffset`) so the token lines up with the
cursor after emoji or CJK text. `src/tests/text-offset.test.ts` checks the conversion
against a real textarea, so an OpenTUI change to these units fails a test.

## Code

- `src/path-suggestions.ts`: token parsing, replacement, windowing, and the walker
  (`listPathSuggestions`, a `PathLister`).
- `src/mentions.ts` (`Mentions`: `update` / `move` / `dismiss` / `accept`): state and
  request ordering, owned by `SessionController.mentions` (`controller.mention` reads the
  open list). The lister is the fifth `SessionController` argument; `null` disables it
  (tests pass fakes; remote mode passes `null`).
- `src/components/MentionList.tsx`: the rows. Its height is `mentionRows()`, reported in
  `footerExtras().mentionRows` so the welcome screen hides the logo when the list needs
  the room.
