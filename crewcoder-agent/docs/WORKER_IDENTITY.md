# Optional worker identity

Worker identity is an optional layer of the system prompt. It adds the selected
worker's name, owner metadata, description, and `IDENTITY.md` persona. It is
disabled by default. New users start with the normal system prompt and no worker
persona; `identity on` explicitly enables it. A saved `workerIdentityEnabled: true`
remains enabled.

## Turn identity on or off

From a shell:

```sh
crewcoder identity off
crewcoder identity on
crewcoder identity status
crewcoder identity status --json
```

The equivalent persistent config setting is:

```sh
crewcoder config set workerIdentityEnabled false
crewcoder config set workerIdentityEnabled true
```

In the TUI:

```txt
/identity off
/identity on
/identity status
```

Bare `/identity` shows the current TUI setting. Use `/reload` after changing
config from another process. Remote TUI commands change config on the backend host.

## What the setting controls

`activeWorker` continues to store the selected worker name. The separate boolean
`workerIdentityEnabled` controls whether that worker's identity is added to
model prompts. Disabling identity preserves worker files and the selected name.
Re-enabling restores the same selected identity.

With identity off, the normal mode/system prompt, selected custom system prompt,
host system instructions, project rules, tools, and approvals remain available.
Ordinary runs do not resolve or create an automatic default worker. Explicit
`--worker` selections are still validated and can identify jobs in worker metadata,
but they do not override identity being off.

The TUI shows the current mode instead of a selected worker's name while identity
is disabled. Choosing a worker does not silently enable identity.

## Timing and host policy

Changes apply to future runs. An in-flight provider request keeps its already
assembled prompt, and historical conversation text is retained. Start a fresh
session when you want a conversation without earlier identity-related messages.

For ACP hosts, both user config and the session instruction policy must permit
worker identity. A host setting `workerIdentity: false` suppresses identity even
when the user setting is on; a host setting `true` cannot override the user's
off setting. Delegated child runs inherit identity suppression. Hosted-tools-only
sessions continue using their host-controlled prompt without worker identity.

## SDK configuration

```ts
const admin = new CrewCoderAdmin({ cwd: process.cwd() });
admin.config.set("workerIdentityEnabled", "false");
console.log(admin.config.get().workerIdentityEnabled);
```

The SDK uses the same configuration and prompt-assembly behavior as the CLI.
See [SDK configuration](SDK.md#configuration-and-integration-profiles) and
[worker crews](WORKER_CREWS.md).
