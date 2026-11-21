# Installing CrewCoder

The unscoped `crewcoder` npm package is the supported umbrella launcher. It declares:

- `@onpoint-dev-tools/crewcoder-agent` as a required dependency (Node.js 22+).
- `@onpoint-dev-tools/crewcoder-tui`, the legacy terminal UI, as a required dependency
  (Node.js 22+). Bare `crewcoder` falls back to it wherever OpenTUI cannot run.
- `@onpoint-dev-tools/crewcoder-opentui`, the OpenTUI terminal UI (preview), as an
  **optional** dependency. It needs Node.js 26.4+ and an OpenTUI native build for the
  platform (Linux x64/arm64 glibc or musl, macOS x64/arm64, Windows x64/arm64). npm
  skips it when it cannot be installed, so headless servers and sandboxes still get a
  working agent.

The legacy UI is also published on its own (`crewcoder-tui` command) for users who
prefer it.

## Try without a persistent install

```sh
npx crewcoder
```

npm downloads the umbrella package and its dependencies into its cache, then opens the TUI. This does not create a persistent global installation.

Arguments are forwarded to the agent CLI:

```sh
npx crewcoder providers
npx crewcoder run "explain this repository"
```

## Install persistently

```sh
npm install --global crewcoder
crewcoder
```

The global install provides `crewcoder` and `crew`. Bare invocations open the TUI; argument-bearing invocations run the agent CLI:

```sh
crew
crewcoder providers
crewcoder run "fix the failing tests"
```

The former `cc` alias was removed because `cc` is the standard Unix C compiler command. Upgrade or reinstall CrewCoder to remove the old npm bin link, then use `crew`:

```sh
npm install --global crewcoder@latest
crew
```

Node.js 22 or newer is required; the new terminal UI additionally needs Node.js 26.4 or newer.

## Which UI bare `crewcoder` opens

| Situation | Result |
|---|---|
| Interactive terminal, Node.js 26.4+, OpenTUI installed | The new OpenTUI UI. |
| Node.js older than OpenTUI's `engines.node` floor (`>=26.4.0`) | The legacy UI, with a notice. |
| `@onpoint-dev-tools/crewcoder-opentui` not installed (npm skipped the optional dependency) | The legacy UI, with a notice. |
| stdin or stdout is not an interactive terminal (CI, pipes, `ssh host crewcoder`) | Exits with status 1 and a short explanation. |
| Neither UI installed (a damaged install) | Exits with status 1 and says to reinstall. |

The notice goes to stderr before the legacy UI starts and again after it exits. It says
why the new UI did not open and how to get it, for example:

```txt
crewcoder: The new terminal UI needs Node.js >=26.4.0 (current 22.13.1). Using the legacy terminal UI instead. To use the new UI, upgrade Node.js to 26.4.0 or newer and run `crewcoder` again.
```

If npm skipped OpenTUI because Node.js was too old at install time, upgrade Node.js and
reinstall (`npm install --global crewcoder`) so npm installs it. Agent commands with
arguments are unaffected in every case.

## Update a global installation

```sh
crewcoder update
```

`crewcoder upgrade` is an alias. The command checks the installed CrewCoder version against the stable `crewcoder@latest` version on npm. When an update exists it prints the current and proposed versions, then presents keyboard-navigable **Yes** and **No** choices. Use the left/right or up/down arrow keys and press Enter. Choosing No leaves the installation unchanged.

For CI, scripts, or another non-interactive terminal, skip the prompt explicitly:

```sh
crewcoder update --yes
```

The update installs the public umbrella package with `npm install --global crewcoder@latest`; that umbrella pins the corresponding CrewCoder agent and OpenTUI packages. If no newer stable release exists, the command prints `current version is up to date` and does not run npm install. A prompt without a TTY fails closed and tells the caller to use `--yes`.

Running `npm install --global crewcoder@latest` directly also updates an existing global install, but it does not provide CrewCoder's version preview and confirmation.

## Scoped packages

The scoped packages remain independently installable for embedding, packaging, or development workflows. Most CLI users should install the `crewcoder` umbrella instead of installing the agent and a TUI separately.
