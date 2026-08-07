# Core tool output safety

CrewCoder bounds model-visible tool output so one command, generated line, or directory cannot
consume the session context window. These contracts follow the proven limits used by Pi's coding
agent while retaining CrewCoder's workspace sandbox and host filesystem interfaces.

## Shared limits

Text-heavy core tools use these defaults:

- 50 KB maximum model-visible output;
- 2,000 lines maximum where line-oriented output applies;
- head retention for file/list output;
- tail retention for shell output, where final errors and summaries are usually most useful.

A truncation notice is part of the tool result. Truncation must never be silent because the model
otherwise treats an incomplete result as complete.

## Tool behavior

### `grep`

- Defaults to 100 matches.
- Caps each matching line at 500 characters.
- Caps aggregate output at 50 KB.
- Tells the model to narrow the pattern/path or use `read` for a full line.

A match-count limit alone is insufficient: a single minified/generated line can be multiple
megabytes.

### `read`

- Supports one-based `offset` and optional line `limit`.
- Caps output at 2,000 lines and 50 KB; a smaller `maxBytes` remains available.
- Reports the next offset when more complete lines remain.
- Calls out a single line that exceeds the byte limit instead of pretending offset pagination can
  recover the omitted middle of that line.
- Keeps image handling separate so binary bytes never enter text context.

### `bash`

- Keeps the final 2,000 lines or 50 KB.
- Labels truncated output explicitly.
- Terminates the spawned Unix process group on timeout/abort so shell descendants do not survive
  the tool call.
- Retains CrewCoder's configured timeout and sandbox/network-isolation behavior.

CrewCoder does not persist full shell output to a temporary file. That avoids silently writing
potential secrets outside the workspace; users can explicitly redirect output to a chosen file.

### `listFiles`

- Sorts every directory before traversal for deterministic output.
- Enforces both `maxFiles` and the shared 50 KB output cap.
- Reports which limit was reached and tells the model to narrow the path.

### Other high-volume results

Background-job status keeps a bounded tail. Git blame/diff and LSP responses keep a bounded head
with explicit notices, and transaction previews are bounded without changing the committed edit or
its structured audit details. This prevents less-common tools from bypassing the same context
safety boundary.

### `edit` and `write`

- Check cancellation before starting filesystem work.
- A non-`replaceAll` edit must match exactly once. Ambiguous target text is rejected with guidance
  to provide more context.
- `replaceAll` remains explicit and reports its replacement count.
- Identical find/replace text is rejected as a no-op.

Transactional multi-file edits retain their separate all-or-nothing validation and rollback
contract.

## Deliberate differences from Pi

CrewCoder does not copy Pi's TUI render components, automatic `fd`/`rg` downloads, unrestricted
absolute-path behavior, or temporary full-output persistence. CrewCoder tools stay constrained to
the workspace, use the existing host text-filesystem boundary for ACP/SSH, and leave display
projection to the active client.

## Tests

- `src/tests/core-tools.test.ts`
- `src/tests/grep.test.ts`
- `src/tests/tool-images.test.ts`
- `src/tests/bash-sandbox.test.ts`
