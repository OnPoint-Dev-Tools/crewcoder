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

## Scoped packages

The scoped packages remain independently installable for embedding, packaging, or development workflows. Most CLI users should install the `crewcoder` umbrella instead of installing the agent and TUI separately.
