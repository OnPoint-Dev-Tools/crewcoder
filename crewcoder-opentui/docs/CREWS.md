# Crews and teams

`/crew` and `/team` run CrewCoder workers one after another and stream every worker into
the transcript, live, the same way a normal run streams. Workers must exist first
(`crewcoder workers create <name>`); teams come from the workspace's `crewcoder.json`
(`/teams` lists them). See `../../crewcoder-agent/docs/WORKER_CREWS.md`.

```txt
/crew planner,builder,reviewer Add checkout validation
/team feature Add checkout validation
```

```txt
 ● /team feature Add checkout validation        your message (filled circle, theme primary)
 ╭──────────────────────────────────────╮
 │ ⠏ Crew running  2 agents · 1 active  │      roster panel (block-panels.ts)
 │ ⠏ planner                            │
 │ ○ builder                            │
 ╰──────────────────────────────────────╯
 TASK → planner                                 the worker's brief, muted (not typed text)
 Plan: Add checkout validation
 ╭╌ Agent work · planner ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮      one box per worker, approvals included
 ╎ ✓  → Read File                        ╎
 ╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯
 CREW CODER · planner                           replies and reasoning name their worker
```

## How it runs

- `SessionController.startCrew` calls `bridge.crew()` (tui-core), which spawns
  `crewcoder crew run --workers a,b --json-events … -- <task>` or
  `crewcoder crew team run <team> --json-events … -- <task>`. The `--` keeps task text from
  being read as options; worker and team ids must be plain names (`isCrewName`: a letter or
  digit first, then letters, digits, `.`, `_`, `-`), checked before anything spawns.
- The crew inherits provider, model, mode, effort, approval (`review` or `full-access`),
  and the custom system prompt. The agent's crew commands take no budget, images, worker
  override, or external directories, so those do not apply to crews.
- Approvals, follow-ups, extension questions, and `/stop` work as in a normal run: the
  agent attaches the same stdin control channel to crews (`crewcoder-agent`
  `core/run-controls.ts`), and decisions reach whichever worker is running. Before this,
  a crew in review mode auto-denied every gated tool ("Non-interactive approval gate").
- A crew is refused while a run is active.

## tmux

When tmux is installed and the workspace is local, `/crew` and `/team` first ask where
the crew runs (Esc cancels it):

| Choice | What happens |
| --- | --- |
| Run in tmux | A second CrewCoder UI runs the crew in tmux and keeps going after this UI closes. Attach to it to watch and answer approvals. |
| Run here | Streams in this UI. Quitting CrewCoder (Ctrl+C, `/quit`) stops the crew. |

Without tmux, or in `--remote` mode, the crew runs here without asking.

- Inside tmux (`$TMUX` set), the crew opens as a background window in your session
  (`new-window -d`, so you are not pulled away); switch with your prefix + `w`. Outside
  tmux it starts a detached session. Either way this UI records your command and how to
  reach the crew in the transcript (`Attach with: tmux attach -t crew-…`), because an alert
  would vanish on the next key and you need that command later.
- The second UI is this same program started with `--crew-file <path>`
  (`process.execPath`, its flags, and the absolute script path). It gets the provider,
  model, effort, mode, system prompt, and full-access setting, plus the `CREWCODER_*`
  variables and `PATH` (a tmux server keeps its own environment, so nothing else is
  inherited).
- All of that travels in a handoff file, never on the command line (argv shows in `ps`,
  and `CREWCODER_*` variables can hold credentials). `writeCrewHandoff` creates it
  owner-only (`0600`, exclusive create) in the temp directory; `readCrewHandoff` refuses a
  file that is not a regular file owned by this user or that others can read, deletes it
  after reading, validates every field (worker and team ids with `isCrewName`), and applies
  only `CREWCODER_*` and `PATH` from it. If tmux fails to start, the file is removed and the
  error shows as an alert. A second UI that dies before reading it leaves the owner-only
  file in the temp directory.
- The tmux crew UI is independent: it has its own sidebar, approvals, and `/stop`, and it
  stays open after the crew finishes so you can read the result.

Code: `src/tmux.ts` (pure argument building and handoff validation; `systemTmux()` is the
real launcher, probed once at startup with `tmux -V`). `SessionController.crewTmux` is
wired by `cli.tsx`; tests use a fake launcher and never start tmux.

## What the shared reducer does during a crew

While `state.crewRunning` (from `crew_start` until `crew_end`):

- Worker `agent_start`/`session_saved` never move `state.sessionId`: the next prompt
  continues your session, not the last worker's. Worker session ids go to
  `state.crewSessionIds` and onto the roster.
- A worker's `agent_end` does not mark the UI idle; `crew_end` (or the process exiting)
  does.
- User, reasoning, tool, approval, and reply blocks get `worker` set to the running worker.
  A worker-tagged `user` block is the worker's brief: it renders as `TASK → <worker>`,
  never with the `●` user marker, and prompt history and the session name skip it.
- `stopCrew` finishes a crew that stopped early: workers still pending or running are
  marked failed with a reason, so neither the roster nor the sidebar shows them running.
  `abort` (Esc, `/stop`), `/new`, and opening another session call it; the reducer calls
  it on `crew_end` (workers that never ran: "Did not run.") and on `process_exit`.

## Sidebar

Starting a crew opens the sidebar (once; closing it again is respected). Its AGENTS section
shows the live roster while any worker is pending or running, then hides; the finished
roster stays in the transcript panel. CREW TASKS includes tasks the workers created in
their own sessions (`tasksForSessions` with `state.crewSessionIds`). Those ids live in
memory only: after reopening the session later, workers' tasks are no longer listed.

## Tests

- tui-core `src/tests/event-reducer.test.ts`: session id kept, worker tagging (same brief
  for two workers, approvals with their tool), follow-up not repeated, stopped/exited/thrown
  crews finished; `crew-run-args.test.ts`: argument building and name checks;
  `crew-tasks.test.ts`: `tasksForSessions`.
- `crewcoder-agent/src/tests/run-controls.test.ts`: control channel only with a JSON sink,
  and a crew worker's gated tool approved over stdin.
- `src/tests/command-runner.test.ts` ("crews"), `session-controller.test.ts` (streamed
  crew, abort, `/new`; "crews in tmux": the question, Run here, Run in tmux through a file
  with no task on the command line, Esc cancels, failed launch removes the file, no
  question without tmux), `sidebar-model.test.ts` (worker tasks), `app.test.tsx` ("crews":
  transcript labels, AGENTS roster live then gone), `tmux.test.ts` (tmux arguments, names,
  forwarded variables, handoff permissions and validation).

Verified in a real terminal (tmux, real agent CLI with the heuristic model): two workers
streamed, both approvals answered from the approval card with Ctrl+Y, approvals in each
worker's box, the roster moved from builder to checker in the sidebar and cleared at the end.
Run in tmux: from inside tmux the crew opened as a background window; quitting the first UI
left it running, both approvals were answered there, and it finished. From outside tmux it
started a detached session (on a private `TMUX_TMPDIR` socket for the test) and the
transcript showed the attach command. Handoff files were gone afterwards.
