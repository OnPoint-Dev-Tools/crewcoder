# Extension Install

`crewcoder extension install` acquires a CrewCoder extension from GitHub, any git remote, or a
local directory. Implementation: `src/extensions/extension-install.ts`. Tests:
`src/tests/extension-install.test.ts`.

## Commands

```bash
crewcoder extension install nextjs-workflows                 # registry alias, see EXTENSION_REGISTRY.md
crewcoder extension install acme/nextjs-workflows            # GitHub, default branch
crewcoder extension install acme/nextjs-workflows@v1.2.0     # pinned to a tag/branch/sha
crewcoder extension install acme/mono@main#packages/lint     # subdirectory of a monorepo
crewcoder extension install https://gitlab.com/acme/pack.git # any git remote
crewcoder extension install ./my-extension                   # local directory
crewcoder extension update <id>                              # reinstall from recorded source
crewcoder extension uninstall <id>                           # remove + clear trust state
```

Flags: `--from <url|path>` (explicit source, bypasses shorthand parsing), `--ref <ref>`,
`--subdir <path>`, `--force` (replace an existing install).

## Source resolution

| Input | Kind | Resolves to |
|---|---|---|
| `name`, `name@ref` | registry alias | the `source` of the matching registry entry, then re-resolved |
| `owner/repo` | `github` | `https://github.com/owner/repo.git` |
| `https://…`, `git@host:…`, `file://…`, `ssh://…` | `git` | used verbatim as a clone URL |
| `./x`, `/x`, `~/x` | `local` | directory copy, no git involved |

`@ref` is only treated as a ref separator when the `@` appears after the last `/` and the last
`:`. That keeps `git@github.com:acme/pack.git` and `https://user@host/acme/pack` intact instead
of shearing off their userinfo.

`file://` is deliberately a git transport, not a copy: it honours refs like any other remote.

A bare name is only resolved through a registry when it contains no `/`, `\`, or `:`, does not
start with `.`/`~`, and `--from` was not used. That keeps explicit specs immune to registry
redirection. See [EXTENSION_REGISTRY.md](EXTENSION_REGISTRY.md).

## Pipeline

0. **Resolve.** A bare name becomes a source spec via the registry index; everything else is
   parsed directly.
1. **Stage.** Clone or copy into a `mkdtemp` directory, never directly into the extensions dir.
   `loadCrewCoderExtensions()` scans `<home>/extensions` on every run, so a partially written or
   invalid package must never be visible there.
2. **Validate.** Run `validateExtensionManifest()` against the staged manifest. Failure aborts
   and nothing lands.
3. **Check the id.** The install directory name *is* `manifest.id`, because `getExtensionDir()`,
   trust, enable, and disable all key off it. The id must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`,
   which also stops a manifest from writing outside the extensions directory.
4. **Collision.** An existing install aborts unless `--force`, which moves the old copy to
   `<home>/extensions/.backups/<id>-<timestamp>` rather than deleting it.
5. **Strip and record.** Remove `.git`, write `.crewcoder-install.json` provenance.
6. **Place.** Copy the staged package to `<home>/extensions/<id>`.

## Provenance

```jsonc
// <home>/extensions/<id>/.crewcoder-install.json
{ "spec": "acme/nextjs-workflows@v1.2.0",
  "alias": "nextjs-workflows",                          // only when a registry alias was typed
  "registry": "https://example.com/registry.json",
  "kind": "github",
  "location": "https://github.com/acme/nextjs-workflows.git",
  "ref": "v1.2.0",
  "commit": "a1b2c3d…",
  "installedAt": "2026-07-25T22:00:00.000Z" }
```

`extension update` re-runs the pipeline from this record. An extension created locally by
`extension init` has no record and reports that clearly instead of guessing a source.

## Trust boundary

**Install never grants trust.** A freshly installed extension sits at the default `prompt-only`
tier: its `skills`, `promptPacks`, and `commands` compose into prompts, while `tools`, `hooks`,
`fileTriggers`, `approvalPolicies`, `validators`, `liveUi`, and `main` stay inert until the user
runs `crewcoder extension trust <id> --tier sandboxed|trusted`.

Install prints the manifest's requested capabilities and declared network hosts so that decision
is informed:

```
Installed demo-pack (Demo Pack v1.0.0)
  source: /tmp/smoke-ext
  path:   <home>/extensions/demo-pack
  contributes: 1 skill, 1 tool
  network: api.example.com
  Executable contributions stay inert at the default prompt-only tier.
  Grant access with: crewcoder extension trust demo-pack --tier sandboxed
```

The sandbox (`src/core/sandbox.ts`) gates *execution*, not *acquisition*. Cloning a repo is inert;
granting trust is the moment third-party code can run. The capability summary is what makes that
step an informed one, so do not remove it or auto-trust on install.

`extension uninstall` clears the id from `trustedExtensions`, `sandboxedExtensions`, and
`disabledExtensions`, so a future extension reusing the id does not inherit stale trust.

## Requirements

`git` must be on `PATH` for `github`/`git` sources. Missing git produces an explicit error rather
than a raw spawn failure. Clones run with `GIT_TERMINAL_PROMPT=0` and no shell; spec values reach
git as literal argv entries.
