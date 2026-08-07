# Remote Agents over SSH

CrewCoder TUI can run on your local PC while the CrewCoder agent and workspace run on another PC, VPS, or SSH-accessible sandbox.

```txt
local PC                                  remote PC / VPS
┌────────────────────┐                    ┌──────────────────────────┐
│ crewcoder-tui      │  SSH stdin/stdout  │ CrewCoder agent binary   │
│ rendering + input  ├───────────────────►│ provider + tools         │
│ approvals          │  JSON events       │ /workspace/project       │
└────────────────────┘◄───────────────────┴──────────────────────────┘
```

SSH provides transport encryption, host verification, and user authentication. The agent executes tools against the remote workspace; the TUI only renders events and sends controls.

This mode does not use fleet HTTP or the fleet bearer token. It executes the remote CrewCoder CLI directly through SSH, which preserves sessions, providers, workers, goals, approvals, extensions, compaction, rewind, and other CLI-backed TUI features without duplicating them into a second API.

## Requirements

On the local PC:

- CrewCoder TUI installed or linked;
- an OpenSSH-compatible `ssh` command;
- SSH keys or another non-interactive authentication setup;
- the remote host key accepted before launching the TUI.

On the remote machine:

- the CrewCoder agent executable;
- the project/workspace directory;
- provider credentials and required development tools;
- a POSIX-compatible login shell.

The remote machine does not need Node.js when using CrewCoder's standalone Linux x64 agent binary.

## 1. Deploy the agent to the remote machine

Build and deploy from the local development machine:

```sh
npm run build:standalone -w @crewcode/crewcoder-agent

crewcoder deploy user@vps \
  --binary crewcoder-agent/dist-bin/crewcoder-linux-x64 \
  --execute
```

The default remote TUI path is:

```txt
~/crewcoder-runner/crewcoder
```

Fleet deployment also starts the HTTP runner, but remote TUI mode does not require the HTTP server or its token. It only reuses the deployed agent executable.

## 2. Prepare the remote workspace and provider

Verify SSH and the remote CrewCoder binary before opening the TUI:

```sh
ssh user@vps 'mkdir -p ~/work/my-project'
ssh -T user@vps \
  'cd ~/work/my-project && ~/crewcoder-runner/crewcoder providers --json'
```

Clone or copy the repository to the remote machine if needed:

```sh
ssh user@vps \
  'git clone https://example.com/your/repository.git ~/work/my-project'
```

Provider credentials belong on the remote machine because provider requests are made there. For example, configure the remote CrewCoder auth store or export the provider API key from the remote non-interactive SSH environment.

## 3. Launch the local TUI against the remote agent

Run this on your local PC:

```sh
crewcoder-tui \
  --remote user@vps \
  --remote-cwd '~/work/my-project'
```

The status bar shows the active location:

```txt
user@vps:~/work/my-project
```

Every normal message now starts or resumes the agent on the VPS. Tool calls, shell commands, file edits, Git operations, sessions, checkpoints, and goals operate on the remote workspace.

## Custom remote binary path

If CrewCoder is installed elsewhere:

```sh
crewcoder-tui \
  --remote user@vps \
  --remote-cwd /srv/projects/my-project \
  --remote-bin /opt/crewcoder/bin/crewcoder
```

Use `--remote-bin crewcoder` when the remote executable is reliably available on the non-interactive SSH `PATH`.

## SSH aliases, ports, and identity files

Put connection details in `~/.ssh/config` instead of passing arbitrary SSH options through CrewCoder:

```sshconfig
Host crewcoder-vps
  HostName 203.0.113.20
  User developer
  Port 2222
  IdentityFile ~/.ssh/crewcoder_ed25519
  IdentitiesOnly yes
```

Then launch:

```sh
crewcoder-tui \
  --remote crewcoder-vps \
  --remote-cwd /srv/projects/my-project
```

CrewCoder rejects remote targets beginning with `-` or containing whitespace, preventing the target field from becoming an SSH option injection surface.

## Environment-variable form

The CLI flags map to these local environment variables:

```sh
export CREWCODER_REMOTE=user@vps
export CREWCODER_REMOTE_CWD=/srv/projects/my-project
export CREWCODER_REMOTE_BIN='~/crewcoder-runner/crewcoder'
crewcoder-tui
```

CLI flags set the same values for the launched TUI process. They are connection configuration, not remote provider environment variables.

## What works remotely

The SSH transport carries the existing newline-delimited JSON and stdin control protocols, so these features continue to use the remote agent implementation:

- new prompts and durable session continuation;
- assistant and thinking streams;
- tool execution and file-change events;
- interactive approvals and extension UI requests;
- follow-ups and stopping an active run;
- providers, models, modes, workers, skills, and prompt commands;
- session listing, resume, branch, compact, rewind, export, and `/why`;
- detached goals and review summaries;
- declarative extension renderers.

Closing or stopping a run closes the local SSH subprocess, which disconnects the attached remote CLI operation. Detached goals continue because their supervisor is intentionally independent of the attached TUI process.

## Current limitations

Features that depend on local files cannot safely pretend those files exist remotely. Remote SSH mode therefore handles them explicitly:

- Local clipboard image attachments are rejected before the run starts. Upload the image to the remote workspace and reference it in text for now.
- `@` path suggestions are disabled because the local TUI does not scan the remote filesystem.
- Sandboxed extension live-UI worker modules are disabled because their JavaScript entry files exist on the remote host, not the local PC. Declarative extension UI requests and renderers still work.
- Applying a locally edited idle compaction summary is disabled because the temporary summary file is local. Ordinary `/compact` and live control-channel compaction previews still work.
- The sidebar Git row and task widget do not inspect the remote filesystem directly. The footer still identifies the remote target/CWD; agent-emitted file changes and CLI-backed Git commands still work.
- Local clipboard/file upload and remote filesystem completion can be added later through an explicit transfer/proxy contract.

These limitations prevent accidental edits or reads against a similarly named local directory.

## Troubleshooting

### SSH asks for a password inside the TUI

Configure key authentication and test it before launch:

```sh
ssh -T user@vps true
```

The TUI uses piped stdin for agent controls, so interactive password entry is not a reliable runtime workflow.

### Host verification fails

Connect once outside the TUI, verify the fingerprint, and accept it:

```sh
ssh user@vps
```

Do not disable host-key verification to bypass this check.

### Remote binary not found

Verify the exact path:

```sh
ssh -T user@vps \
  'test -x ~/crewcoder-runner/crewcoder && echo ready'
```

Then pass `--remote-bin` when using a different location.

### Remote workspace not found

The TUI runs every remote command after changing to `--remote-cwd`. Verify it:

```sh
ssh -T user@vps 'cd /srv/projects/my-project && pwd'
```

### JSON parsing errors or unexpected stdout

Remote shell startup files must not print banners or diagnostics to stdout for non-interactive SSH commands. Test the stream:

```sh
ssh -T user@vps \
  'cd /srv/projects/my-project && ~/crewcoder-runner/crewcoder providers --json'
```

Move shell banners to interactive-only startup branches or send diagnostics to stderr.

### Provider authentication fails

The provider runs remotely. Logging in or exporting an API key only on the local PC does not authenticate the VPS. Configure provider credentials on the remote machine and rerun the `providers --json` check.

## Security notes

- Prefer SSH keys protected by an agent or hardware-backed key.
- Verify host fingerprints.
- Keep the remote CrewCoder binary and workspace permissions restricted to the remote account.
- The remote target, workspace, executable, and every CLI argument are shell-quoted before execution.
- No fleet bearer token is placed in SSH commands or process arguments.
- Use fleet mode through SSH tunnels or HTTPS for custom HTTP/SDK clients; use this SSH mode for the full local TUI experience.
