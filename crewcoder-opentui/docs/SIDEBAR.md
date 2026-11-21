# Right sidebar

A port of the legacy `RightSidebar` and `TaskWidget`. The sidebar is the only persistent
place for workspace and git state, modified files, live crew agents, and crew tasks.

```txt
  STATUS 1                          only with extension safety policies
  SAFETY  2 · 1 block · 1 review
─────────────────────────────
  MODIFIED FILES 3                  newest kept; "… N more" when they do not fit
  ● src/sidebar-model.ts
  ● src/an/extremely/long/nest      paths wrap under the bullet, never truncate
    ed/path/that/wraps.ts
─────────────────────────────
  AGENTS: builder                   only while a crew has pending/running workers
  ⠼ builder running
  □ reviewer queued
─────────────────────────────
  CREW TASKS — 1/3 completed        only when tasks are on; this session's and its crews' tasks
  ◉ 2. Porting the sidebar          active (activeForm), bold
  ! 3. Verify in tmux               blocked
  ✓ 1. Read the legacy sidebar      done, struck through
                                    (blank rows push the footer down)
─────────────────────────────
  ~/projects/app:feature*           <cwd>:<git>, wrapped; <target>:<cwd> over SSH
                                    git label "local" outside git and over SSH
  • CrewCoder
```

## Controls

| Control | Effect |
| --- | --- |
| Ctrl+B (`toggleSidebar`) | open or close |
| `/sidebar` | toggle; `/sidebar on`, `off`, and `status` are explicit |
| `/file-changes` | toggle the modified-files list; `on`, `off`, and `status` are explicit |
| drag the divider | resize, from 18 up to 60 columns, always leaving the conversation 32 |

The sidebar starts closed, as in the legacy UI. Open/closed, the dragged width, and the
file-changes setting belong to this UI instance: nothing is saved and nothing affects
another instance. `/file-changes off` hides the list only. Tracking continues, so
`/file-changes on` restores it. The setting survives `/new`.

Below 60 terminal columns the sidebar is hidden but stays open, so it comes back when the
terminal widens. `/sidebar on` in a narrow terminal says so.

## Layout

`App` lays out a row: the main column (welcome screen, or transcript and footer) at
`width = terminal - sidebar - 1`, the divider, then the sidebar at full height. Every
width-dependent piece (welcome logo rule, status line, pickers, question card) uses the
main column's width, not the terminal's.

The divider is a `box` with a left border, not text. A press on text starts a mouse
selection, but a pressed box captures OpenTUI's drag events, so `onMouseDrag` reports
the column and the new width is `terminal - x - 1`.

## Code

- `src/sidebar-model.ts` (pure): `sidebarWidth`, `clampSidebarWidth`, and `sidebarRows`,
  which returns exactly `height` rows of styled spans, each at most `width` cells
  (measured with `string-width`, so CJK and emoji count as two). Section budgets match
  legacy: files at most 30% of the height (3 to 9 rows), agents 25% (2 to 8), tasks get
  the rest. A list that does not fit keeps a row for `… N more`. The legacy UI dropped that
  line when the items filled the budget exactly.
- `src/sidebar.ts`: `SidebarController`, owned by `SessionController.sidebar`. It holds
  open/closed state, the width, and the task snapshot. While open, it rereads the task
  store every second (`TASK_POLL_MS`), after each `tool_execution_end`, and after
  `agent_end`, and it re-renders only when the snapshot changed. After every `agent_end` it
  refreshes `state.gitLabel` with tui-core `readGitLabelAsync`, so a run that dirtied the
  tree shows `*` without blocking the UI.
- `src/components/Sidebar.tsx`: draws the rows. The worker spinner ticks only while a
  worker runs.
- The task store reader is shared with the legacy UI: tui-core `state/crew-tasks`
  (`readCrewTaskSnapshot`, `tasksForSessions`, `sessionDisplayNumbers`, `prioritizedTasks`).
  It mirrors the agent's store paths (`<cwd>/.crewcoder/tasks/tasks.json`, enabled by
  `$CREWCODER_HOME/tasks/config.json` or the instance `CREWCODER_TASKS_ENABLED` override
  from `/task on|off`).

## Remote SSH mode

`cli.tsx` puts the remote target and remote cwd into state (`state.remoteTarget`,
`state.cwd`), so the footer and the welcome screen show `<target>:<cwd>`. The task
reader is `null` (seventh `SessionController` argument): the store lives on the remote
disk, so the section says "Not shown for SSH workspaces" instead of reading a local path.
The git label and repo name are never read from the local directory in remote mode.

## Tests

- `src/tests/sidebar-model.test.ts`: widths and bounds, exact height, footer anchored,
  `<target>:<cwd>`, wrapping in cells, file budget and `… N more`, file-changes off,
  agents only while live, safety status, task progress and markers, SSH note.
- `src/tests/sidebar.test.ts`: polling only while open, re-render only on change, failed
  reads keep the last snapshot, refresh on tool/run end, git label refresh, drag clamp,
  `/sidebar` and `/file-changes` (bare toggles, explicit forms, narrow warning, tracking
  kept across `/new`).
- `src/tests/app.test.tsx` ("right sidebar"): Ctrl+B open and close with the divider and a
  narrower composer, tasks and agents rendered, hidden below 60 columns, the welcome logo
  beside it, dragging the divider.
- tui-core `src/tests/crew-tasks.test.ts` and `git-status.test.ts` (`readGitLabelAsync`).

Verified in a real terminal (tmux, fake agent through `CREWCODER_BIN`, tasks on through
`CREWCODER_HOME`): sections, wrapping, theme colors (`muted` background, `border`
divider), `/sidebar status`, Ctrl+B close, Ctrl+C exit.

Crews (`docs/CREWS.md`): starting `/crew` or `/team` opens the sidebar. A crew that stops
early (abort, crash, a worker that threw) is finished by tui-core `stopCrew`, so AGENTS no
longer stays stuck on `queued` workers. CREW TASKS also lists tasks the crew's workers
created in their own sessions (`state.crewSessionIds`, in memory for this UI session).
