# Bring-your-own Codex CLI provider

The `codex-cli` provider is CrewCoder's sole Codex provider and fresh-install default.
It runs the user's installed Codex CLI (`codex app-server --stdio`) with its own
login. CrewCoder never reads, copies, refreshes, or stores those tokens. The former
managed `codex` provider and `crewcoder login codex` flow have been removed.

## Setup

```bash
codex login                 # the user's normal Codex CLI sign-in
crewcoder config set defaultProvider codex-cli # replace a previously configured codex default
crewcoder auth --json       # codex-cli should report "signed-in"
crewcoder run --provider codex-cli --model gpt-5.6-luna "inspect this repository"
```

The binary is `codex` on `PATH`, or `CREWCODER_CODEX_PATH`. On Windows, npm installs `codex` as a `.cmd` shim that a shell-free spawn cannot start, so set `CREWCODER_CODEX_PATH` to the real `codex.exe`. Codex reads its normal `CODEX_HOME` (default `~/.codex`); CrewCoder does not override it.

Over ACP, select it with a `codex-cli:<model>` model id.

## Assistant dialogue and reasoning

Codex `agentMessage` items, including `phase: commentary`, stream as assistant
dialogue (`assistant_delta`, or ACP `agent_message_chunk`). Commentary is a public
reply, so host acknowledgement gates can observe it before a following tool call.
Dynamic-tool dispatch waits for prior assistant stream callbacks to finish, even
when RPC notifications arrive together. This waits for delivery, not a user reply
or speech playback. Actual `reasoning` items retain the separate thinking channel.

Completion-only replies and unstreamed suffixes are emitted once per message item.
Separate replies use paragraph breaks; the saved assistant response includes both
commentary and final text. A final reply is retained even when only commentary
had live deltas. This does not let thinking satisfy a host acknowledgement gate.

Regression command from the repository root:

```sh
node node_modules/vitest/vitest.mjs run --config test/codex-commentary.config.ts
```

## Approval questions

Native approval dialogs display the provider's reason as the wrapped question,
without appending the raw shell command. The command remains in its tool transcript
entry. Allow once, Allow session, and Decline keep their provider decision values;
cancellation or an unrecognized answer declines the request.

Computer-use and browser MCP services can also send
`mcpServer/elicitation/request`. CrewCoder forwards consent-only forms and URL
confirmation through its provider-question channel, including ACP permission
cards in CrewCode. It sends an explicit MCP action and content, preserving the
numeric or string request id. Cancellation or a missing interactive host cancels
the request. Data forms require a JSON object; ACP currently cannot collect
free-text provider questions unless the host negotiates the version-1
`crewcoder/questions` extension. Updated CrewCode negotiates that extension and
collects JSON data through its request card; other clients cancel these forms
instead of inventing data.
Unknown server requests receive an explicit JSON-RPC error.

Full access now uses Codex `on-request` with `danger-full-access`, preserving
automatic command/file approval while allowing the service's own consent and
additional-permission questions. Review uses `on-request` with workspace-write.
Never and Sandboxed remain non-interactive. Hosted-tools-only lockdown is
unchanged: native computer use and MCP servers remain disabled and unsolicited
elicitation requests are declined.

This uses the computer-use service already configured in the user's Codex
installation. It does not install a backend or expose Codex's private native
tools to other providers. In SSH sessions, Codex and its configured services run
on the workspace host; they do not thereby gain access to the client desktop.

The current direction is to reuse provider-specific computer-use integrations
where available. A universal CrewCoder computer-use backend is deferred.
Other adapters must explicitly expose their provider's tools and consent flow;
a model supporting computer use is not sufficient. Claude's built-in CLI
computer-use server is documented as macOS-only and unavailable in
non-interactive mode, so CrewCoder's Agent SDK transport cannot currently
reuse it. Claude Desktop's Windows support does not establish SDK support.
See [Claude Code computer use](https://code.claude.com/docs/en/computer-use).
Connecting an external automation service would be separate work; do not
disable strict MCP isolation as a workaround.

## Image results from hosted tools

CrewCoder's guest/local read tool declares images on the tool result's image metadata.
The Codex app-server adapter now reads those authorized local files and sends their
pixels as dynamic-tool inputImage content items alongside the text description.
Native view_image remains disabled in hosted-tools-only sessions. ACP client text
I/O and hosted-text-only tools do not gain a binary filesystem fallback.

Code mode converts dynamic-tool image items into data-URL lines in the returned
string. Sending that string through `text(result)` delivers base64 text, not
visible pixels; `image(result)` also fails when a description precedes the URL.
The read-tool description and successful image response include this recipe:

```js
const result = await tools.read({ path: "path/to/image.png" });
for (const line of result.split("\n")) {
  if (line.startsWith("data:image/")) image(line);
}
```

The adapter removes the legacy claim that an attached image is only displayed
to the user. Guidance changes invalidate read-enabled native thread contracts,
so resumed sessions get the updated tool description. The existing workspace,
image-size and native-tool restrictions remain in force.

The adapter rechecks workspace and session external-directory scope, sniffs PNG,
JPEG, GIF or WebP bytes, and limits a response to four images, 8 MiB per image and
16 MiB total. Missing, changed, unsupported or oversized images produce a failed
tool response with a readable delivery error, without partial image content.
Image bytes are encoded only on the app-server wire; durable tool records retain
paths and metadata.

Regression command from the repository root:

```sh
node node_modules/vitest/vitest.mjs run --config test/codex-tool-images.config.ts
```

A guest with an older CrewCoder bundle still returns only the binary description.
Build and install the updated bundle in that guest before repeating VM GUI acceptance;
restarting the desktop application alone does not update an existing guest disk.

## No fallback

If the app-server cannot start, the turn fails with the cause. It never falls back to the direct Responses transport, because that would need CrewCoder-owned credentials.

- `Codex CLI was not found` means `codex` is not on the `PATH` CrewCoder was started with. Apps launched from a desktop menu or an AppImage often do not get the shell's `PATH` (for example an npm prefix such as `~/.codex-cli-npm/bin`). Set `CREWCODER_CODEX_PATH` to the codex executable, or add its directory to the environment the app starts with.
- `Codex CLI app-server could not start (...)` carries Codex's own error and the last stderr lines, for example an unsupported flag on an old Codex version or a missing login.

## Hosted-tools-only lockdown

When `toolMode: crewcoder` is selected, or `useProviderNativeFileTools: false` enforces ACP virtual-filesystem or Supervisor custody, only CrewCoder's dynamic tools may act. The launch adds:

| Control | Why |
| --- | --- |
| `--disable` for `shell_tool`, `unified_exec`, `view_image`, `browser_use`, `computer_use`, `apps`, `plugins`, `multi_agent`, `image_generation`, `sleep_tool`, `goals`, `tool_suggest`, `skill_search`, `hooks` | Removes native tools and user hook commands |
| `-c web_search=disabled` | Removes native web search |
| `-c agents.max_depth=0` | Code mode still exposes `multi_agent_v1` spawn tools after `--disable multi_agent` |
| `-c mcp_servers={name={command=...,enabled=false},...}` | Complete inert entries disable every name discovered by `codex mcp list --json` in the session folder, covering global, plugin and trusted project servers. The placeholder command is never launched. An empty table does not clear inherited servers |
| Thread `sandbox: read-only`, turn `sandboxPolicy: readOnly`, `approvalPolicy: never` | Backstop for anything the flags cannot remove, such as `apply_patch` on Codex 0.154 |
| Approval and permission requests answered with decline | Never asks the user to widen native access |

Fail-closed rules:

- Codex 0.167 can reject partial `enabled=false` overrides with `invalid transport`
  when plugin-discovered entries are present. Complete disabled transport entries
  avoid that startup failure without changing the user's config or login.

- Codex refuses to start on an unknown feature name, so a renamed flag stops the launch instead of leaving a tool on.
- If `codex mcp list --json` fails, times out, or returns a server name outside `[A-Za-z0-9_-]`, the launch is refused.

### Code mode stays on

`gpt-5.6-*` and `gpt-6-*` are `tool_mode = "code_mode_only"` in the Codex model catalog. They reach dynamic tools only by writing JavaScript in the native `exec` tool (`await tools.crew_workspace_action(...)`). Disabling `code_mode_host` cuts them off from every CrewCoder tool. The code mode runtime was probed on Codex 0.154 and 0.159: no `require`, `process`, `fetch`, `Deno`, `Bun`, or dynamic `import`. Its `tools` object holds only the dynamic tools plus `apply_patch`, which the read-only sandbox rejects.

## Verified

- Fake Responses endpoint on Codex 0.154 and 0.159: the model is offered only `request_user_input` and the dynamic tools (plus `apply_patch` on 0.154); a scripted `apply_patch` and a code mode escape attempt both failed; a configured MCP server never started.
- Live with a real ChatGPT login and `gpt-5.6-luna`: one typed CrewMate tool call through code mode, read-only sandbox, no MCP or agent tools in the session.

## Limits

- Feature names are tied to the Codex versions above. A Codex update that adds a new native tool under a new feature name is not removed until it is added here. The read-only sandbox still blocks native writes and command execution.
- With native Tool mode, Codex keeps its native tools and the user's full Codex config, as when running `codex` directly. New standalone sessions default to CrewCoder tools. See [Tool mode](TOOL_MODE.md).

## Thinking in ACP hosts

Codex turns request public reasoning summaries with `summary: "auto"`. Accumulate summary deltas by item id and summaryIndex, preserving summaryPartAdded section boundaries. Completed reasoning items replace the streamed sections authoritatively, including corrections or empty results. Shared plans come from item/plan/delta, completed plan items and turn/plan/updated. Raw textDelta remains optional; it is not the general progress channel.

ModelStreamCallbacks.onThinkingDelta retains portable text deltas and may also carry a ProviderProgressUpdate snapshot with itemId, kind, text, sections and completed. The thinking_delta event preserves that snapshot. ACP forwards it through optional `_meta["crewcoder/progress"]` on agent_thought_chunk, alongside portable text for older hosts. Empty text with a snapshot can carry an authoritative correction. Wait for progress publication before completing a turn. Final answers remain separate from progress. Public commentary is mirrored into progress with kind `commentary`, preserving streamed text and authoritative completion. ACP still publishes ordinary commentary dialogue before tool dispatch so host acknowledgement gates remain intact. The terminal JSON sink omits commentary-phase assistant deltas because their text already travels through thinking_delta, keeping commentary out of the terminal final-answer block. No transcript of private internal reasoning is guaranteed.

Portable text includes blank lines when switching reasoning items, summary sections, raw-content sections or plans. Completion-only text uses the same boundaries; final suffixes within a section append without repeating its body. The adapter forwards provider text verbatim apart from these separators. A heading-only provider summary remains heading-only; receiving it does not establish that a longer summary was available.

The terminal `--json-events` stream keeps the established nonempty `{ type: "thinking_delta", text, emittedAt }` shape. Do not send ACP snapshot metadata or empty completion-only events into that terminal contract. Structured completion corrections remain available over ACP. When completed text differs from streamed text, text-only consumers still receive the exposed final text rather than having it suppressed.
