# Bring-your-own Codex CLI provider

The `codex-cli` provider runs the user's own installed Codex CLI (`codex app-server --stdio`) with the user's own Codex login. CrewCoder never reads, copies, refreshes, or stores those tokens. This is the opposite of the `codex` provider, which signs in through `crewcoder login codex` and holds ChatGPT OAuth tokens itself.

## Setup

```bash
codex login                 # the user's normal Codex CLI sign-in
crewcoder auth --json       # codex-cli should report "signed-in"
crewcoder run --provider codex-cli --model gpt-5.6-luna "inspect this repository"
```

The binary is `codex` on `PATH`, or `CREWCODER_CODEX_PATH`. On Windows, npm installs `codex` as a `.cmd` shim that a shell-free spawn cannot start, so set `CREWCODER_CODEX_PATH` to the real `codex.exe`. Codex reads its normal `CODEX_HOME` (default `~/.codex`); CrewCoder does not override it.

Over ACP, select it with a `codex-cli:<model>` model id.

## No fallback

If the app-server cannot start, the turn fails with the cause. It never falls back to the direct Responses transport, because that would need CrewCoder-owned credentials.

- `Codex CLI was not found` means `codex` is not on the `PATH` CrewCoder was started with. Apps launched from a desktop menu or an AppImage often do not get the shell's `PATH` (for example an npm prefix such as `~/.codex-cli-npm/bin`). Set `CREWCODER_CODEX_PATH` to the codex executable, or add its directory to the environment the app starts with.
- `Codex CLI app-server could not start (...)` carries Codex's own error and the last stderr lines, for example an unsupported flag on an old Codex version or a missing login.

## Hosted-tools-only lockdown

When CrewCoder routes the filesystem itself (`useProviderNativeFileTools: false`, which ACP virtual-filesystem sessions and Supervisor hosted sessions set), only CrewCoder's dynamic tools may act. The launch adds:

| Control | Why |
| --- | --- |
| `--disable` for `shell_tool`, `unified_exec`, `view_image`, `browser_use`, `computer_use`, `apps`, `plugins`, `multi_agent`, `image_generation`, `sleep_tool`, `goals`, `tool_suggest`, `skill_search`, `hooks` | Removes native tools and user hook commands |
| `-c web_search=disabled` | Removes native web search |
| `-c agents.max_depth=0` | Code mode still exposes `multi_agent_v1` spawn tools after `--disable multi_agent` |
| `-c mcp_servers.<name>.enabled=false` per server | `-c mcp_servers={}` merges instead of replacing. Names come from `codex mcp list --json` run in the session folder, so global, plugin, and trusted project servers are covered |
| Thread `sandbox: read-only`, turn `sandboxPolicy: readOnly`, `approvalPolicy: never` | Backstop for anything the flags cannot remove, such as `apply_patch` on Codex 0.154 |
| Approval and permission requests answered with decline | Never asks the user to widen native access |

Fail-closed rules:

- Codex refuses to start on an unknown feature name, so a renamed flag stops the launch instead of leaving a tool on.
- If `codex mcp list --json` fails, times out, or returns a server name outside `[A-Za-z0-9_-]`, the launch is refused.

### Code mode stays on

`gpt-5.6-*` and `gpt-6-*` are `tool_mode = "code_mode_only"` in the Codex model catalog. They reach dynamic tools only by writing JavaScript in the native `exec` tool (`await tools.crew_workspace_action(...)`). Disabling `code_mode_host` cuts them off from every CrewCoder tool. The code mode runtime was probed on Codex 0.154 and 0.159: no `require`, `process`, `fetch`, `Deno`, `Bun`, or dynamic `import`. Its `tools` object holds only the dynamic tools plus `apply_patch`, which the read-only sandbox rejects.

## Verified

- Fake Responses endpoint on Codex 0.154 and 0.159: the model is offered only `request_user_input` and the dynamic tools (plus `apply_patch` on 0.154); a scripted `apply_patch` and a code mode escape attempt both failed; a configured MCP server never started.
- Live with a real ChatGPT login and `gpt-5.6-luna`: one typed CrewMate tool call through code mode, read-only sandbox, no MCP or agent tools in the session.

## Limits

- Feature names are tied to the Codex versions above. A Codex update that adds a new native tool under a new feature name is not removed until it is added here. The read-only sandbox still blocks native writes and command execution.
- Without lockdown (plain CrewCoder use), Codex keeps its native tools and the user's full Codex config, as when running `codex` directly.
