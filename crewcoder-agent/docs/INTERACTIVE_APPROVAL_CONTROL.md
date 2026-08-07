# Interactive Approval Control

CrewCoder JSON-events runs support live approval decisions over the same newline-delimited stdin control channel used for follow-ups and compaction.

## Control Message

```json
{"type":"control","action":"approval","approvalId":"approval_call_123","approved":true,"reason":"Approved from TUI control channel."}
```

Fields:

- `approvalId`: The `approval_required.approvalId` value emitted by the backend.
- `approved`: `true` to run the pending tool call, `false` to deny it.
- `reason`: Optional operator-facing reason echoed in `approval_resolved`.

## Runtime Behavior

When `--approval review` or `--approval always` requires review, CrewCoder emits `approval_required` and waits for a matching control decision. Approved calls continue into normal `tool_execution_start` / `tool_execution_end` events. Denied calls produce an error `toolResult`, emit `approval_resolved`, and terminate the current tool batch.

Without an interactive `approvalSignal`, approval gates keep the previous non-interactive behavior and deny immediately.

Dangerous calls are still gated, but an explicit interactive approval now allows the approved call to run. If no interactive approval channel is attached, dangerous calls remain blocked.

## What Triggers Approval

Approval decisions come from `src/core/approval.ts`:

- Unknown tools are `review` risk.
- `bash` is inspected by command text.
- Tools marked `isMutation` are `review` risk.
- Other known non-mutating tools are `safe`.

With `--approval review`, CrewCoder prompts for `review` and `dangerous` risk. With `--approval always`, it prompts for anything that is not `safe`. With `--approval never`, it does not prompt; dangerous calls are blocked. With `--approval full-access`, CrewCoder does not prompt and allows all tool calls, including dangerous bash commands. Use full-access only as an explicit operator opt-in.

Bash commands are `dangerous` when they contain:

- `rm -rf`
- `mkfs`
- `dd if=`
- `shutdown`
- `reboot`
- `chmod -r 777`
- `chown -r`

Bash commands are `review` when they contain:

- `rm `
- `mv `
- `cp `
- `git reset`
- `git clean`
- `npm install`
- `pnpm install`
- `cargo install`
- `curl `
- `wget `
- `sudo`
