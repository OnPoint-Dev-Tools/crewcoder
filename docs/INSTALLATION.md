# Installing CrewCoder

The unscoped `crewcoder` npm package is the supported umbrella launcher. It declares both runtime packages as dependencies:

- `@onpoint-dev-tools/crewcoder-agent`
- `@onpoint-dev-tools/crewcoder-tui`

## Try without a persistent install

```sh
npx crewcoder
```

npm downloads the umbrella package and both runtime dependencies into its cache, then opens the TUI. This does not create a persistent global installation.

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

The global install provides `crewcoder` and `cc`. Bare invocations open the TUI; argument-bearing invocations run the agent CLI:

```sh
cc
crewcoder providers
crewcoder run "fix the failing tests"
```

Node.js 22 or newer is required.

## Update a global installation

```sh
crewcoder update
```

`crewcoder upgrade` is an alias. The command checks the installed CrewCoder version against the stable `crewcoder@latest` version on npm. When an update exists it prints the current and proposed versions, then presents keyboard-navigable **Yes** and **No** choices. Use the left/right or up/down arrow keys and press Enter. Choosing No leaves the installation unchanged.

For CI, scripts, or another non-interactive terminal, skip the prompt explicitly:

```sh
crewcoder update --yes
```

The update installs the public umbrella package with `npm install --global crewcoder@latest`; that umbrella pins the corresponding CrewCoder agent and TUI packages. If no newer stable release exists, the command prints `current version is up to date` and does not run npm install. A prompt without a TTY fails closed and tells the caller to use `--yes`.

Running `npm install --global crewcoder@latest` directly also updates an existing global install, but it does not provide CrewCoder's version preview and confirmation.

## Scoped packages

The scoped packages remain independently installable for embedding, packaging, or development workflows. Most CLI users should install the `crewcoder` umbrella instead of installing the agent and TUI separately.
