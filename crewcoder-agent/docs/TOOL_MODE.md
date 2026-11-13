# Tool mode

Tool mode selects who supplies coding tools for a new standalone CrewCoder session.
The default is `crewcoder`.

| Mode | Tool ownership |
| --- | --- |
| `crewcoder` | CrewCoder built-in tools and enabled trusted extension tools, using CrewCoder execution and approvals. |
| `native` | Codex CLI or Claude Agent SDK native tools. CrewCoder built-in and extension tools are omitted. |

Choose **Settings > /tool-mode** in the command palette, or use:

```text
/tool-mode crewcoder
/tool-mode native
/tool-mode status
```

The equivalent backend setting is:

```sh
crewcoder config set toolMode crewcoder
crewcoder config set toolMode native
```

The setting applies to new sessions. Use `/new` after changing it. A saved session
retains its tool mode on resume even when the global default changes. Branches
inherit their source session's mode. Sessions created before this setting retain
their previous tool behavior. Changing provider does not change the saved mode.

## Provider support

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

Claude supports both modes. CrewCoder mode disables native Read/Grep/Glob and
routes coding actions through CrewCoder's MCP tools. Native mode uses the SDK's
`claude_code` tool preset and forwards SDK permission requests to the interactive
host. Missing, cancelled or unrecognized permission answers decline the request.
Never mode declines requests requiring interactive approval; Full access permits
them. Native mode does not remove strict MCP isolation or enable unsupported
Claude computer use. Claude native mode rejects CrewCoder's OS Sandboxed approval
mode because the adapter does not implement that sandbox.

API-only providers, including OpenCode's Messages transport, cannot supply a
native tool runtime. Selecting native mode with these providers reports an error
before inference. Choose CrewCoder tools or a supported native provider.

Generic process, model-command and nested ACP providers cannot enforce CrewCoder
tool ownership, so new CrewCoder-tool sessions reject these transports before
spawning. Pre-setting sessions retain their prior transport behavior.

## Host policy and specialized modes

Host policy takes precedence over this preference. Hosted-only sessions, virtual
filesystems, supplied tool registries, and host-added tools require CrewCoder
tools. A standalone preference cannot enable a second native filesystem or GUI
path around CrewMate's grants, approvals, VM routing or takeover controls.

The `crewcoder` approved-plan workflow and the `plugin` and `extension` agent
modes also require CrewCoder tools. Native tools cannot enforce the plan's
mutation gate, and the architect modes depend on CrewCoder's specialized tools.

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
