# `/diff` with Hunk

Each edit already shows its diff inline in the transcript (`docs/TRANSCRIPT.md`, "Inline
diffs"). `/diff` is the extra, whole-session review: it opens
[Hunk](https://www.hunk.dev), a full-screen terminal diff viewer, on the files the agent
changed in this session.

CrewCoder does not bundle Hunk: its platform binary is about 185 MB, six times OpenTUI, for
one optional command now that diffs are inline. Install it separately:

```bash
npm install -g hunkdiff     # Node.js 22+; provides `hunk`
brew install hunk           # or Homebrew, mise (`mise use -g hunk`), or hunk.dev/install.sh
```

## What it runs

```txt
hunk diff -- <files this session changed>    # from state.changedFiles (file_changed events)
hunk diff                                    # when the session recorded no changes
```

Paths under the workspace are passed relative to it; duplicates are dropped
(`hunkDiffArgs` in `src/hunk.ts`). Hunk compares the git working tree with `HEAD`, so:

- it needs a git repository;
- uncommitted edits the user made to the same files show too (owner choice over building
  an exact patch from the session's first checkpoint).

## How the terminal is handed over

`SessionController.runInTerminal` is wired in `cli.tsx`: `renderer.suspend()`, spawn Hunk
with stdin/stdout inherited (`spawnInTerminal`), then `renderer.resume()`. Hunk owns the
screen until it exits (`q`). Its stderr is captured, because the UI repaints over anything
printed there, and replayed in an error alert on a non-zero exit.

| Situation | Result |
|---|---|
| `hunk` not on `PATH` | error alert with install commands |
| non-zero exit (not a git repo, ...) | error alert with Hunk's stderr |
| remote SSH mode | warning: the changes live on the remote host |
| no interactive renderer | warning |

## Tests

`src/tests/command-runner.test.ts` ("/diff"): scoped and unscoped arguments, relative paths,
missing Hunk, failure stderr, and no terminal. Real-terminal check: run `/diff` in tmux with
`hunk` on `PATH`, quit Hunk with `q`, and confirm the UI repaints and the composer takes input.
