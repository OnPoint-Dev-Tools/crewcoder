# Git primitive tools

CrewCoder exposes common Git inspection and mutation operations as structured tools instead of requiring shell parsing.

## `git_blame`

Inputs: `path`, optional `startLine`, `endLine`, and `revision`.

Returns `details.lines[]` with:

- line number and text
- full commit hash
- author name/email/time
- commit summary

## `git_log`

Inputs: optional `maxCount` (1–200), `revision`, and workspace-relative `path`.

Returns `details.commits[]` with full/short hashes, parent hashes, author identity, ISO date, subject, and body.

## `git_diff_range`

Inputs: required `from` and `to` revisions, optional `path`, and `contextLines` (0–20).

Returns:

- `details.files[]`: path, additions, deletions, and binary status
- `details.patch`: unified patch

The compared revision expression is `from..to`.

## `git_cherry_pick`

Input: one `commit` revision.

Safety behavior:

- registered as a mutation, so the agent loop creates a filesystem checkpoint and applies normal mutation approval policy
- requires a clean worktree
- resolves the source to a commit before execution
- automatically runs `git cherry-pick --abort` when cherry-pick fails
- records changed paths in the mutation log, producing normal `file_changed` events

The result contains the source commit, newly created commit metadata, and changed paths.

## Input hardening

All tools invoke Git directly without a shell. Revisions beginning with `-` or containing Git revision metacharacters/control characters are rejected, and path filters are constrained to the workspace.
