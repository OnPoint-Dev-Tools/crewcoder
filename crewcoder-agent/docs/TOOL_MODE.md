# Tool mode

Tool mode selects who supplies coding tools for a new standalone CrewCoder session.
The default preference is `native`: use provider-native execution when supported, complemented by CrewCoder specialized tools. API-only providers use the full CrewCoder toolset.

| Mode | Tool ownership |
| --- | --- |
| `crewcoder` | CrewCoder built-in tools and enabled trusted extension tools, using CrewCoder execution and approvals. |
| `native` | Codex CLI or Claude Agent SDK native execution plus CrewCoder specialized and trusted extension tools. Providers without a supported native runtime use the full CrewCoder toolset. |

Choose **Settings > /tool-mode** in the command palette, or use:

```text
/tool-mode crewcoder
/tool-mode native
/tool-mode status
```

The direct CLI command switches the same setting:

```sh
crewcoder tool-mode                 # show the current preference and config path
crewcoder tool-mode status
crewcoder tool-mode native
crewcoder tool-mode crewcoder
crewcoder tool-mode status --json   # { "toolMode": "...", "configPath": "..." }
```

The preference is saved as `toolMode` in CrewCoder's `config.json`:

```json
{
  "toolMode": "native"
}
```

Set the value to `"crewcoder"` for full CrewCoder execution. The command reports
the active config path, including a `CREWCODER_HOME` override. JSON output contains
only the mode and path, rather than unrelated configuration. Invalid modes fail
without changing the saved preference. The equivalent generic config commands remain:

```sh
crewcoder config set toolMode crewcoder
crewcoder config set toolMode native
```

The setting applies to new sessions. Use `/new` after changing it. A saved session
retains its tool preference on resume even when the global default changes. API
fallback does not overwrite a native preference, so switching back to Codex/Claude
restores native execution. Branches inherit their source session's mode. Sessions created before this setting retain
their previous tool behavior. Changing provider does not change the saved mode.

## Provider support

### Specialized tools remain available

Native execution includes CrewCoder's `edit_symbol`, `edit_transaction`, Git
primitives, LSP definition/hover/diagnostics, `remember`, `delegateWorker`, and
persistent `Task*` tools. Task tools still require tasks to be enabled; memory
and language-server prerequisites remain unchanged. Trusted extension tools retain
their existing config and trust gates. Ordinary CrewCoder `read`, `write`,
`edit`, `grep`, `listFiles`, `bash`, and `background_job` are omitted in
favor of native equivalents. Native subagents remain available; prefer CrewCoder
worker delegation when CrewCoder should own the worker lifecycle.

Specialized tools still execute through CrewCoder's approval, hook, checkpoint,
and event paths. Native actions use the provider's permission and reporting paths.
Native file tools read disk and do not automatically see unsaved editor buffers.

### Native providers

Codex CLI supports both modes. CrewCoder mode uses the same native feature and
MCP lockdown as hosted sessions, including a read-only native sandbox as a
backstop for native writes. CrewCoder tools still read, execute and write through
their normal executor and CrewCoder approval policy.

Workspace edits remain available through CrewCoder tools under every approval
policy. Review and Always request permission for mutations; Full access executes
them automatically, and Never and Sandboxed permit ordinary workspace edits
without prompts. Actual denials, workspace scope and approved-plan gates still
apply. The Codex adapter explicitly explains that its native read-only/never
notice does not describe CrewCoder dynamic tools, including how to call them in
code mode. This guidance is part of the native thread contract, so existing
sessions receive it through a replacement provider thread on their next turn.

Native `apply_patch` is also omitted from the actual Codex tool registry, including
the tools callable from code mode. On current Codex versions it is controlled by
model metadata rather than the removed `apply_patch_freeform` feature. Before a
hosted launch, CrewCoder runs the installed CLI's `debug models` command in the
workspace with the same process-only lockdown flags. This obtains the effective
catalogue, including custom aliases, instructions and capabilities. CrewCoder
copies its model entries with only `apply_patch_tool_type` changed to `null`,
then passes the copy through a process-only `model_catalog_json` override.

The generated catalogue lives under CrewCoder's cache in
`codex-hosted-model-catalog/<content-hash>.json`; identical metadata produces the
same path so pooled processes remain reusable. Writes are atomic. This does not
change the user's Codex configuration, catalogue, credentials, native tool mode,
or other model fields. The native read-only sandbox remains a backstop. The
catalogue probe is cancellable, limited to 20 seconds and 8 MiB, and rejects an
empty/malformed catalogue or a missing explicitly selected model before inference.
The installed Codex CLI must support `debug models` and `model_catalog_json`.
Do not fall back to offering a blocked native patch tool when discovery fails.
Discovery failures include the observed exit code/signal and bounded, redacted
stderr. A nonzero status alone does not establish a missing update or login.
Disabled MCP overrides preserve the observed transport kind: HTTP entries use
an inert HTTP URL, while stdio/plugin-only entries use an inert command. Codex
merges these overrides with user configuration, so supplying a command on an
HTTP entry would retain its URL and fail configuration decoding before inference.

Claude supports both modes. CrewCoder mode disables native Read/Grep/Glob and
routes coding actions through CrewCoder's MCP tools. Native mode uses the SDK's
`claude_code` tool preset alongside CrewCoder specialized/extension MCP tools and
forwards SDK permission requests to the interactive host. Missing, cancelled or
unrecognized permission answers decline the request.
Never mode declines requests requiring interactive approval; Full access permits
them. Native mode does not remove strict MCP isolation or enable unsupported
Claude computer use. When OS Sandboxed approval is selected, the loop uses full
CrewCoder execution
for Claude because the SDK native adapter does not implement that sandbox. Direct
attempts to use Claude native tools with OS Sandboxed approval still fail closed.

API-only providers, including OpenCode's Messages transport, cannot supply a
native tool runtime. A native preference automatically selects the full CrewCoder
toolset for those providers. Custom model clients without a declared provider id
also receive the full CrewCoder toolset. Runtime selection reads provider metadata
without launching discovery or fetching model catalogs.

Generic process, model-command and nested ACP providers cannot enforce CrewCoder
tool ownership, so new CrewCoder-tool sessions reject these transports before
spawning. Pre-setting sessions retain their prior transport behavior.

## Host policy and specialized modes

Host policy takes precedence over this preference. Hosted-only sessions, virtual
filesystems, and replacement tool registries require CrewCoder tools. Additive host
tools (such as ACP artifacts) stay available alongside native execution and do not
by themselves establish host custody. A standalone preference cannot enable a
second native filesystem or GUI
path around CrewMate's grants, approvals, VM routing or takeover controls.

The `crewcoder` approved-plan workflow and the `plugin` and `extension` agent
modes also require CrewCoder tools. Native tools cannot enforce the plan's
mutation gate, and the architect modes depend on CrewCoder's specialized tools.
Detached goals explicitly use CrewCoder execution so approvals remain durable and
can wait for `goal approve`/`goal deny` rather than an interactive native dialog.

Tool mode does not change logins, provider/model selection, conversation storage,
or TUI commands such as sessions, settings, branching and compaction. Enabled
CrewCoder context hooks and prompt contributions retain their existing behavior.
Automatic CrewCoder mutation checkpoints, extension tool interception, and
CrewCoder file-change recording apply to CrewCoder tools. Native actions follow
their provider's execution and reporting behavior.

## Verification

From the repository root:

```sh
node node_modules/vitest/vitest.mjs run --config test/tool-mode.config.ts
npm run typecheck -w @onpoint-dev-tools/crewcoder-agent
npm run typecheck -w @onpoint-dev-tools/crewcoder-tui
```

The focused suite covers config validation, session pinning, pre-setting sessions,
host precedence, hosted writes, unsupported providers, Codex process flags and
permission responses, Claude SDK tool selection and permissions, and the TUI
picker and persistence failures. These are automated adapter and rendering checks;
live provider and terminal acceptance is separate.

The real Codex tool registry can also be checked without a model API request:

```sh
# After compiling crewcoder-agent (tsc -p crewcoder-agent/tsconfig.build.json):
CREWCODER_VERIFY_CODEX_PATH=/absolute/path/to/codex node scripts/verify-codex-hosted-tools.mjs
```

This starts the installed Codex CLI with an isolated temporary home and a local
fake Responses server. It checks `ALL_TOOLS` inside the real code-mode runtime,
executes a supplied editing tool, and repeats after native thread resume. Both
turns must omit `apply_patch`, keep `edit`, update only a temporary file and retain
the same native thread. It neither uses login credentials nor calls a model API.
The isolated config includes enabled HTTP and stdio MCP servers. No stdio server
may start and no HTTP tool call may execute during either native turn. Codex's
initial `mcp list` discovery can probe HTTP authentication before the disabled
overrides exist; the verifier records those probes separately from tool execution.
