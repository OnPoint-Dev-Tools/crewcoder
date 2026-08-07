# CrewCoder Extensions

CrewCoder extensions are capability-based packages. They are not categorized as provider extensions, skill extensions, prompt extensions, or tool extensions. One extension can contribute any combination of capabilities.

## Install location

```txt
/.crewcoder/extensions/<extension-id>/crewcoder.extension.json
```

`CREWCODER_HOME` overrides `/.crewcoder`.

## Initialize

```bash
crewcoder extension init my-extension
```

`crewcoder extension create my-extension` is kept as an alias. The old `--kind` flag is deprecated and ignored.

## Manifest contract

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "0.1.0",
  "description": "Describe what this extension adds.",
  "crewcoder": { "apiVersion": "0.1" },
  "main": "index.ts",
  "activation": {
    "events": [],
    "keywords": [],
    "modes": [],
    "commands": [],
    "filePatterns": []
  },
  "contributes": {
    "providers": [],
    "tools": [],
    "skills": [],
    "promptPacks": [],
    "commands": [],
    "workflows": [],
    "contextProviders": [],
    "validators": [],
    "approvalPolicies": [],
    "hooks": [],
    "ui": [],
    "liveUi": []
  }
}
```

Unknown/future contribution point names are allowed by the TypeScript contract so the architecture can grow without forcing authors into categories.

## Runtime status

Active today:

- `main` module entry points are loaded through CrewCoderExtAPI only when both `allowExtensionModules=true` and the extension id is in `trustedExtensions`.
- `providers` are merged into the provider registry after their curated transport contract is validated. Extensions may select generic process, HTTP/SSE, OpenAI Responses, Anthropic Messages, or WebSocket runtimes, but cannot select credential-owning built-in adapters such as ChatGPT OAuth Codex. See `docs/contributor/PROVIDER_TRANSPORTS.md`.
- `skills` are trigger-matched against the prompt and injected into the system prompt.
- `promptPacks` are matched by id/title and injected into the system prompt.
- `tools` are loaded as agent tools only when both `allowExtensionTools=true` and the extension id is in `trustedExtensions`.
- `commands` are surfaced as reusable prompt commands in `crewcoder command list/show` and the TUI `/commands` picker.
- `liveUi` is experimental but active in `crewcoder-tui`: entry modules run in isolated `worker_threads` workers after config, trust, manifest, surface, path, and permission gates pass. See `docs/LIVE_UI_COMPONENTS.md` and `../crewcoder-tui/docs/LIVE_UI_SANDBOX.md`.
- `hooks` can run trusted local commands for `context`, `beforeToolCall`, `afterToolCall`, `onError`, and `compaction` events when both `allowExtensionHooks=true` and the extension has the required trust tier.
- `approvalPolicies` can force review or block matching tool calls when both `allowExtensionHooks=true` and the extension id is in `trustedExtensions`.
- `fileTriggers` can run trusted local commands after CrewCoder tool mutations emit `file_changed`, gated by `allowExtensionHooks=true` and trusted extension id.
- Module `agent_event` handlers receive emitted agent lifecycle/tool/session/provider events when `allowExtensionModules=true` and the extension id is in `trustedExtensions`.

Capability checklist:

| Capability | Status |
| --- | --- |
| Custom tools | Active through manifest commands or `crew.defineTool()`, trusted/gated via `allowExtensionTools` + `trustedExtensions`; module tools also require `allowExtensionModules`. |
| Event interception | Active for context injection plus before/after tool-call hooks; manifest hooks or `crew.handleEvent(...)` handlers can allow, block, or modify args. Module `agent_event` handlers can observe emitted run/tool/session/provider events for workflow automation. |
| Safety policies | Active for trusted manifest `approvalPolicies`: extensions can force review or block matching tool/path/command calls before execution, even when the built-in approval mode would allow them. |
| File triggers | Active for trusted manifest `fileTriggers`: extensions can run local commands after agent tool mutations report changed files. This is post-tool only, not a background watcher. |
| User interaction | Active end-to-end: `ctx.ui.notify/confirm/input/select/component` route to the interactive host (TUI / JSON-events driver) through `extension_ui_*` events and the `ui_response` control message. The TUI renders `notify` inline and opens a focused popup (`ExtensionUiOverlay`) for blocking prompts and declarative components. Available in command handlers and event handlers; in non-interactive `crewcoder command run` print mode, `notify` messages are collected and printed while blocking prompts use safe defaults. |
| Custom UI components | Active in the TUI: declarative `ctx.ui.component(...)`, declarative tool renderers, and experimental sandboxed Live UI workers for modal/transcript/status surfaces. Live UI remains deny-by-default and requires explicit trust/config/permission gates. |
| Custom commands | Active as reusable prompt commands, namespaced under `ext.<extension>.<command>`. |
| Session persistence | Active for entries: `crew.writeSessionEntry(type, data)` entries are persisted to `SessionRecord.extensionEntries` and replayed (deduped, per-extension) on resume; read your own history with `crew.getSessionEntries()`. The legacy free-form `extensionState` field remains reserved with no public API. |
| Custom rendering | Active for trusted declarative tool renderers: tool events/results carry structured `metadata`/`details`, and the TUI can render matching tool blocks with extension-provided markdown templates. |

## CrewCoderExtAPI modules

A module extension exports a default factory function that receives `CrewCoderExtAPI`:

```ts
import type { CrewCoderExtAPI } from "@crewcode/crewcoder-agent";

export default function (crew: CrewCoderExtAPI) {
  crew.handleEvent("context", async () => ({
    context: "Always mention the project release checklist before release work."
  }));

  crew.handleEvent("before_tool_call", async (event) => {
    if (event.toolCall.name === "bash" && String(event.toolCall.arguments.command ?? "").includes("rm -rf")) {
      return { action: "block", reason: "Dangerous shell command blocked by extension." };
    }
  });

  crew.defineTool({
    name: "greet",
    description: "Greet someone by name.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    },
    async execute(_toolCallId, args) {
      return { content: [{ type: "text", text: `Hello, ${String(args.name)}!` }] };
    }
  });

  crew.defineCommand("hello", {
    description: "Run a hello command.",
    async handler(args, ctx) {
      ctx.ui.notify(`Hello ${args || "world"}`);
    }
  });
}
```

Enable module execution explicitly:

```bash
crewcoder config set allowExtensionModules true
crewcoder config set allowExtensionTools true  # only needed for crew.defineTool exposure
crewcoder extension trust my-extension
```

Supported module events today:

- `session_start`
- `context`
- `before_tool_call`
- `after_tool_call`
- `agent_event`

`agent_event` receives the same `AgentEvent` objects emitted by the agent loop after they are sent to the host event sink. This is an observation hook for workflow automation and telemetry; return values are ignored. Use it for durable session entries, notifications, external logging, or lightweight automation.

Subscribe to all events:

```ts
crew.handleEvent("agent_event", async (event, ctx) => {
  if (event.type === "tool_execution_end") {
    crew.writeSessionEntry("tool-observed", { toolName: event.toolName, isError: event.isError });
    ctx.ui.notify(`Observed ${event.toolName}`, event.isError ? "warning" : "info");
  }
});
```

Or filter by `AgentEvent.type` to avoid noisy handlers:

```ts
crew.handleEvent("agent_event", { types: ["tool_execution_end", "session_saved"] }, async (event) => {
  crew.writeSessionEntry("observed-event", { type: event.type });
});
```

`crew.defineCommand()` commands appear in `crewcoder command list`, the TUI `/commands` picker, and can be invoked directly in the TUI as `/ext.<extension-id>.<command-name> args...`. When run through `crewcoder command run` (including direct TUI `/ext...` dispatch), `ctx.ui.notify()` messages are printed to stdout/stderr so command handlers have a visible result channel in print mode.

`crew.writeSessionEntry(customType, data?)` records a durable, extension-scoped entry. Entries are persisted to `SessionRecord.extensionEntries` when the run is saved and replayed into the runtime when the session is resumed, so an extension can read its own history with `crew.getSessionEntries()` (returns only that extension's entries). Replay is idempotent — entries are deduped by extension id + timestamp + type — so resuming the same session twice in one process does not duplicate history.

Extension handlers and commands also receive workflow helpers on `ctx`:

```ts
crew.handleEvent("agent_event", { types: ["session_saved"] }, async (_event, ctx) => {
  const branch = await ctx.git.currentBranch();
  const files = await ctx.git.changedFiles();
  if (files.length) await ctx.git.createCheckpoint(`checkpoint ${branch ?? "workspace"}`);
});
```

Available git helpers:

- `ctx.git.status()` returns `{ branch, clean, entries, raw }` from `git status --porcelain`.
- `ctx.git.currentBranch()` returns the current branch name when available.
- `ctx.git.changedFiles()` returns unique changed/untracked file paths.
- `ctx.git.createCheckpoint(reason)` creates a bounded session checkpoint.
- `ctx.git.issueReferences()` extracts issue-like references such as `#123`, `GH-123`, and `issue_123` from branch/status/recent commit text. Recognized GitHub/GitLab remotes add issue URLs.
- `ctx.git.reviewSummary()` returns branch, clean/dirty state, changed files, issue references, issue URLs, and raw status details for review flows.

## Extension UI bridge

`ctx.ui` lets a trusted extension talk to the user from command and event handlers:

```ts
ctx.ui.notify("Indexing finished", "success");        // fire-and-forget toast/log
const ok = await ctx.ui.confirm("Apply changes?");    // boolean
const name = await ctx.ui.input("Branch name?", { defaultValue: "main" });
const target = await ctx.ui.select("Deploy to", ["staging", "prod"]);
const action = await ctx.ui.component(
  "Repo Status",
  { kind: "details", items: [{ label: "Branch", value: "main" }] },
  { actions: [{ id: "apply", label: "Apply" }, { id: "close", label: "Close" }] }
);
```

How it works (`src/core/extension-ui-bridge.ts`):

- `notify` emits an `extension_ui_notify` event the host renders. It never blocks.
- `confirm` / `input` / `select` / `component` emit an `extension_ui_request` event carrying a unique
  `requestId`, then await a matching control message
  `{"type":"control","action":"ui_response","requestId":"…","value":<bool|string|null>}`.
  This mirrors the tool-approval handshake. When the request resolves, the host receives an
  `extension_ui_resolved` event.
- Responses are scoped per extension: each handler's `ctx.ui` only emits/notifies under its own
  extension id.
- **Fallback:** when no interactive host is attached (`hasUI === false`, e.g. plain
  `crewcoder prompt run` or print-mode runs), every call returns a safe non-blocking default
  (`notify` → no-op, `confirm` → false, `input` → its `defaultValue`, `select` → first option,
  `component` → first action id or `undefined`), so extensions never hang a headless run.

The interactive host (TUI) drives the response side: `CrewCoderProcess.resolveUiRequest(requestId, value)`
writes the `ui_response` control message. The TUI renders `notify` inline and opens a focused popup
(`ExtensionUiOverlay`, mirroring the approval card) for `confirm`/`input`/`select`/`component`: arrow keys
+ enter for confirm/select/component actions, free text + enter for input, and `esc` cancels the request
(sends `null`). Requests render in the transcript as an `extension_ui` block that moves from `pending` to
`answered`/`cancelled`.

### Durable action handling

Combine `ctx.ui.component(...)` actions with the durable session store so a user decision is captured
once and replayed on resume instead of re-prompting. The command reads its own history with
`ctx.getSessionEntries()`, and only opens the action prompt when there is no recorded decision:

```ts
crew.defineCommand("triage", {
  description: "Triage a finding with a durable decision",
  async handler(args, ctx) {
    const key = (args || "").trim() || "default";

    // On resume, prior entries are replayed into the runtime, so a recorded
    // decision short-circuits the prompt and keeps the command idempotent.
    const prior = ctx.getSessionEntries().find(
      (entry) => entry.customType === "triage-decision" && (entry.data as { key?: string })?.key === key
    );
    if (prior) {
      ctx.ui.notify(`Already decided ${key}: ${(prior.data as { action: string }).action}`, "info");
      return;
    }

    const action = await ctx.ui.component("Triage " + key, {
      kind: "actionList",
      actions: [
        { id: "fix", label: "Fix now" },
        { id: "ignore", label: "Ignore" }
      ]
    });

    // Persisted to SessionRecord.extensionEntries and replayed on the next resume.
    ctx.writeSessionEntry("triage-decision", { key, action: action ?? "skipped" });
    ctx.ui.notify(`Recorded ${key}: ${action ?? "skipped"}`, "success");
  }
});
```

Why this is durable, not just interactive:

- `ctx.ui.component(...)` returns the selected action id (or `undefined` when cancelled / headless-defaulted).
- `ctx.writeSessionEntry(type, data)` records the decision; the agent loop persists it to
  `SessionRecord.extensionEntries` when the run is saved.
- On resume the entries are replayed (deduped by extension id + timestamp + type), so
  `ctx.getSessionEntries()` returns the prior decision and the command does not re-prompt for the same key.
- In a headless run (`hasUI === false`) `component` returns the first action id, so the decision is still
  recorded deterministically without blocking.

This idempotent-across-resume behavior is covered by
`src/tests/extension-runtime.test.ts` ("handles a durable UI action idempotently across a resume replay").

Declarative component schemas are intentionally data-only and never execute extension UI code. Extensions that need local state or advanced input can declare experimental `liveUi` entries; the TUI executes those entries outside its main process in permission-gated `worker_threads` workers with bounded frames, lifecycle timeouts, focus isolation, and crash fallback.

```ts
type CrewCoderExtUiComponent =
  | { kind: "markdown"; text: string }
  | { kind: "details"; items: Array<{ label: string; value: string }> }
  | { kind: "table"; columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string | number | boolean | null | undefined>> }
  | { kind: "actionList"; actions: Array<{ id: string; label: string; description?: string }> };
```

`ctx.ui.component(...)` returns the selected action id, or `undefined` when cancelled or when the host
returns an unknown action. If no explicit actions are supplied, non-`actionList` components get a default
`close` action.

Component payloads are bounded before they are emitted to the host: markdown text is capped at 8,000
characters, details at 50 items, tables at 8 columns and 100 rows, labels/keys at 120 characters,
cell/detail/action descriptions at 1,000 characters, and actions at 20 entries. Extra table fields outside
the declared columns are dropped. These limits keep trusted extension UI data-only and prevent a component
request from overwhelming the TUI.

Extension command example:

```json
{
  "contributes": {
    "commands": [
      {
        "id": "fix-issue",
        "title": "Fix Issue",
        "description": "Insert an issue-fixing prompt.",
        "content": "Fix {{issue}} in {{area}}. Priority: {{arg:priority}}.",
        "arguments": [
          { "name": "issue", "description": "Issue number or URL", "required": true },
          { "name": "area", "description": "Code area", "default": "the current project" },
          { "name": "priority", "default": "normal" }
        ]
      },
      {
        "id": "release-checklist",
        "title": "Release Checklist",
        "file": "prompts/release-checklist.md"
      }
    ]
  }
}
```

Extension command names are namespaced as `ext.<extension-id>.<command-id>` with unsafe characters replaced by `_`.

Command templates support `{{name}}` and `{{arg:name}}` placeholders. Missing required args leave their placeholder in the prompt and are reported in command metadata.

```bash
crewcoder command list
crewcoder command show ext.my-extension.fix-issue --arg issue=#123 area=backend
```

In the TUI:

```txt
/commands ext.my-extension.fix-issue issue=#123 area=backend
```

Trusted tool example:

```json
{
  "contributes": {
    "tools": [
      {
        "id": "repo-audit",
        "title": "Repo Audit",
        "description": "Run a local repo audit command.",
        "icon": "◎",
        "category": "diagnostics",
        "renderer": "audit.summary",
        "command": "node",
        "args": ["./audit.js", "{{argsJson}}"],
        "parameters": {
          "type": "object",
          "properties": { "scope": { "type": "string" } },
          "required": ["scope"],
          "additionalProperties": false
        },
        "isMutation": false,
        "timeoutMs": 30000
      }
    ]
  }
}
```

Enable trusted tools explicitly:

```bash
crewcoder config set allowExtensionTools true
crewcoder extension trust my-extension
```

The exposed tool name is namespaced as `extension_<extension-id>_<tool-id>` with unsafe characters replaced by `_`.

Tool argument templates:

- `{{argsJson}}` or `{{json}}` — full tool arguments as JSON
- `{{arg:name}}` — one argument value
- `{{arg:nested.value}}` — nested argument value
- `{{cwd}}` — current workspace
- `{{sessionId}}` — active session id

Trusted approval policy example:

```json
{
  "contributes": {
    "approvalPolicies": [
      {
        "id": "protect-env",
        "title": "Protect env files",
        "action": "block",
        "paths": [".env*", "**/.env*"],
        "reason": "Secret-bearing env files are protected."
      },
      {
        "id": "review-deploy",
        "title": "Review deploy commands",
        "action": "review",
        "tools": ["bash"],
        "commands": ["deploy", "/kubectl\\s+apply/"]
      }
    ]
  }
}
```

Policy fields:

- `action`: `block`, `review`, or `allow`.
- `tools`: exact/glob-like tool name matches such as `bash`, `write`, or `extension_*_deploy`.
- `paths`: glob-like matches against path-like tool args (`path`, `file`, `directory`, `target`, `cwd`, `out`). Patterns can be workspace-relative (`.env*`, `secrets/**`) or absolute (`/repo/.env*`). When a tool sends both `cwd` and an absolute path under that `cwd`, CrewCoder also checks the workspace-relative form.
- `commands`: substring, glob-like, or `/regex/` matches against bash `command` text.
- `reason`: optional text shown in blocked results or approval prompts.

Enable trusted approval policies with the hook safety gate:

```bash
crewcoder config set allowExtensionHooks true
crewcoder extension trust my-extension
```

Inspect active trusted policies:

```bash
crewcoder extension approval-policies
crewcoder extension approval-policies --json
```

At run startup the backend also emits `extension_safety_policies` with the active trusted policy list. The TUI stores that event and shows a `SAFETY` status pill with the active block/review count.

`block` policies stop execution before `tool_execution_start`. `review` policies force an approval prompt before execution, including in modes where the built-in approval decision would otherwise allow the call.

Trusted file trigger example:

```json
{
  "contributes": {
    "fileTriggers": [
      {
        "id": "docs-changed",
        "title": "Docs Changed",
        "patterns": ["docs/**/*.md", "README.md"],
        "command": "node",
        "args": ["./on-doc-change.js", "{{path}}"],
        "env": { "CHANGED_PATH": "{{path}}" },
        "timeoutMs": 10000
      }
    ]
  }
}
```

File triggers run after `file_changed` events emitted by CrewCoder tools. They do not watch the filesystem in the background. Trigger commands receive a JSON payload on stdin and in `CREWCODER_EXTENSION_FILE_TRIGGER_PAYLOAD`:

```json
{ "path": "docs/guide.md", "toolName": "write", "cwd": "/repo", "sessionId": "session_..." }
```

Template variables for `args` and `env`:

- `{{path}}`
- `{{toolName}}`
- `{{cwd}}`
- `{{sessionId}}`
- `{{json}}` / `{{payloadJson}}`

Enable trusted file triggers with the hook safety gate:

```bash
crewcoder config set allowExtensionHooks true
crewcoder extension trust my-extension
```

Trusted hook example:

```json
{
  "contributes": {
    "hooks": [
      {
        "id": "repo-context",
        "title": "Repo Context",
        "event": "context",
        "command": "node",
        "args": ["./context-hook.js"],
        "timeoutMs": 10000
      },
      {
        "id": "tool-policy",
        "title": "Tool Policy",
        "event": "beforeToolCall",
        "command": "node",
        "args": ["./policy-hook.js"]
      }
    ]
  }
}
```

Hook commands receive a JSON payload on stdin and in `CREWCODER_EXTENSION_HOOK_PAYLOAD`. They should print JSON:

- `context`: `{ "context": "extra instructions or facts" }`
- `beforeToolCall`: `{ "action": "allow" }`, `{ "action": "block", "reason": "..." }`, or `{ "action": "modify", "args": { ... } }`
- `afterToolCall` / `onError`: `{ "context": "observation to log" }`
- `compaction`: `{ "summary": "replacement" }`, `{ "append": "required context" }`, or both

Enable trusted hooks explicitly:

```bash
crewcoder config set allowExtensionHooks true
crewcoder extension trust my-extension
```

### Custom rendering metadata

Tool results can now carry structured data for future custom renderers:

- Tool implementations return `ToolResult.details`.
- The agent persists those details on `ToolResultMessage.details`.
- JSON events expose them as `tool_execution_end.metadata` and on `result.details`.
- The TUI stores that data on tool blocks as `block.metadata`.

Extension tools also get standard metadata. Manifest and module tools can add display hints with `title`/`label`, `icon`, `category`, and `renderer`; these flow through tool result details and TUI tool block metadata:

```json
{
  "source": "extension",
  "extensionId": "my-extension",
  "toolId": "repo-audit",
  "label": "Repo Audit",
  "icon": "◎",
  "category": "diagnostics",
  "renderer": "audit.summary"
}
```

The TUI uses `label`, `icon`, and `category` for default tool block display. `renderer` can match declarative renderer hooks.

Trusted declarative renderer hooks can consume this metadata in the TUI without changing the event contract again:

```json
{
  "contributes": {
    "ui": [
      {
        "id": "audit-summary",
        "title": "Audit Summary",
        "kind": "renderer",
        "target": "tool",
        "match": {
          "extensionId": "my-extension",
          "toolId": "repo-audit",
          "renderer": "audit.summary"
        },
        "template": "## {{metadata.title}}\nScope: **{{args.scope}}**\n{{text}}"
      }
    ]
  }
}
```

Renderer hooks are deliberately non-interactive and string-only for now:

- Loaded by the TUI through `crewcoder extension renderers --json`.
- Available only when `allowExtensionModules=true` and the extension id is trusted.
- Match fields are exact equality checks against tool block data: `extensionId`, `toolId`, and `renderer` read from `block.metadata`; `toolName` reads from the tool name.
- Templates support `{{name}}`, `{{status}}`, `{{text}}`, `{{args.path.to.value}}`, and `{{metadata.path.to.value}}`, then render as markdown.
- If no renderer matches, the fixed built-in TUI tool renderer is used.

### Live custom UI component contract

`contributes.liveUi[]` provides experimental code-backed UI components. Declarative components and renderer templates remain the default. Live UI entries must set `experimental: true`, declare an extension-relative `entry`, target `modal`, `transcript`, or `status`, include activation/match rules, and request explicit permissions. The agent validates and lists contributions; the TUI applies all trust gates before loading an entry in an isolated worker.

The exported Live UI boundary types are JSON-serializable. The shipped TUI host uses structured-clone messages over `worker_threads`; the type system reserves stdio JSONL for a possible future host:

- `CrewCoderLiveUiProps`
- `CrewCoderLiveUiHost`
- `CrewCoderLiveUiInstance`
- `CrewCoderLiveUiHostMessage`
- `CrewCoderLiveUiChildMessage`

See `docs/LIVE_UI_COMPONENTS.md` for the full manifest shape, permission model, load gates, and process message contract.

Runtime status for the remaining contribution points:

- `workflows` are active through `crewcoder workflow list|show|run`; fixed tool steps require sandboxed/trusted extensions.
- `validators` are active during `--verify` when extension hook execution is enabled and trusted.
- `contextProviders` remain a declared manifest contract; module `context` handlers provide the active programmable context path.
- `liveUi` is active experimentally in the TUI worker sandbox (`docs/LIVE_UI_COMPONENTS.md`).

## Design principle

An extension is a package. Capabilities are contributions. Do not ask users to pick a kind.
