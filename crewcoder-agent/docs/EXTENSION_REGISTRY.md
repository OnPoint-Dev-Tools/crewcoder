# Extension Registry Index

`crewcoder extension search` discovers extensions across one or more registry index files.
Implementation: `src/extensions/extension-registry-index.ts`. Tests:
`src/tests/extension-registry-index.test.ts`.

A registry is **discovery only**. It resolves a short name to a source spec that
[`extension install`](EXTENSION_INSTALL.md) already understands, then hands off. It never
acquires code, never bypasses manifest validation, and never grants trust.

## The built-in registry

```
https://crewcoder-extensions.cortex-ai.icu/v1/index.json
```

`DEFAULT_EXTENSION_REGISTRY` in `extension-registry-index.ts`, searched by default. Source for the
published document lives in a separate repo, `crewcoder-extensions` (sibling checkout at
`../crewcoder-extensions`). Listing submissions are PRs there, deliberately not against this
repo: extension listings and agent source should not share a review queue.

It is a **config flag** (`useDefaultExtensionRegistry`, default `true`), not a seeded entry in
`extensionRegistries`. That distinction matters: `config.json` is written on first read, so an
existing install already has `"extensionRegistries": []` on disk and a seeded default would only
ever reach installs created after this build. The flag applies to everyone.

`registry remove <that URL>` flips the flag off; `registry add <that URL>` flips it back on
without duplicating the URL into the user list. `crewcoder config set useDefaultExtensionRegistry
false` works too.

The `/v1/` path segment is load-bearing. `RegistryIndex.version` is a hard gate — a client that
understands only version 1 rejects a version 2 document — so a future format must live at `/v2/`
while `/v1/` keeps serving older installs. Changing the URL is a breaking change for every
installed client.

## Commands

```bash
crewcoder extension search nextjs                                   # built-in registry, no setup
crewcoder extension registry add https://example.com/registry.json  # extra remote index
crewcoder extension registry add ./registry.json                    # local/private index
crewcoder extension registry list [--json] [--refresh]
crewcoder extension registry remove <url>
crewcoder extension registry refresh                                # clear cache + re-fetch

crewcoder extension search nextjs workflows [--json] [--limit 20] [--registry <match>] [--refresh]
crewcoder extension install nextjs-workflows        # alias resolved through the registry
crewcoder extension install nextjs-workflows@v1.2.0 # user-typed ref overrides the indexed one
```

`config.extensionRegistries` holds *extra* registries and starts empty; the built-in above is
always searched unless disabled. `crewcoder config set extensionRegistries <comma-separated>`
also works.

## Index format

```jsonc
{
  "version": 1,
  "name": "Acme Extension Registry",
  "updatedAt": "2026-07-26T00:00:00.000Z",
  "extensions": [
    {
      "id": "nextjs-workflows",              // required, must be a safe directory name
      "name": "Next.js Workflows",           // defaults to id
      "source": "acme/nextjs-workflows",     // required, any `extension install` spec
      "version": "1.2.0",
      "description": "Release and lint workflows for Next.js apps",
      "author": "acme",
      "homepage": "https://github.com/acme/nextjs-workflows",
      "keywords": ["nextjs", "release"],
      "contributes": ["workflows"],          // advisory
      "requiresTrust": true                  // advisory
    }
  ]
}
```

`version` must be `1`. `contributes`/`requiresTrust` are registry *claims* used to sort and warn;
the authoritative capability summary is the one install prints from the real manifest. Malformed
entries (bad id, missing source, duplicate id, non-object) are dropped with a warning rather than
failing the whole index — one bad row should not hide a healthy registry.

## Search ranking

Query terms are ANDed: every term must match something, so more words narrow the result set.
Per-term score, best field wins:

| Match | Score |
|---|---|
| exact id | 100 |
| id substring | 45 |
| name substring | 30 |
| exact keyword | 25 |
| keyword substring | 15 |
| contribution point | 12 |
| description substring | 8 |

Ties break on id. An empty query lists everything. Hits already present in
`<home>/extensions` are marked `[installed]`.

## Alias resolution in `install`

`installExtension()` calls `resolveInstallSpec()` first. Only a **bare name** is a candidate:
anything containing `/`, `\`, or `:`, anything starting with `.` or `~`, and anything passed via
`--from` goes straight to `parseExtensionSpec()` untouched. A registry can therefore never
redirect an install the user already spelled out.

Registries are consulted in order with the **first match winning**, and user registries are
ordered **before** the built-in one. A private index therefore shadows an id published in the
first-party registry.

A user-typed `@ref` on the alias replaces any ref baked into the indexed source
(`python-lint@v3` beats an indexed `acme/python-lint@v2`).

Provenance records both sides:

```jsonc
// <home>/extensions/<id>/.crewcoder-install.json
{ "spec": "acme/nextjs-workflows",              // the resolved source
  "alias": "nextjs-workflows",                  // what the user typed
  "registry": "https://example.com/registry.json",
  "kind": "github", "location": "…", "commit": "…", "installedAt": "…" }
```

`extension update` reinstalls from `spec`, not from the registry, so an update cannot be
hijacked by a later index edit that repoints the name. The `alias`/`registry` fields are carried
through for provenance only.

## Caching and failure behavior

Remote (`http`/`https`) indexes are cached under `<home>/cache/registries/<sha256>.json` with a
6-hour TTL. `--refresh` and `registry refresh` bypass it. Local paths and `file:` URLs are always
read fresh.

Failures are per registry, never fatal:

- A refetch that fails while a cached copy exists serves the **stale cache** and reports the
  staleness in `error`. A search should keep working when the network is down.
- With no cache, the registry reports an error and search continues over the remaining ones.
- Fetches are capped at 10s and 8 MB. A cache write failure is swallowed; it must not fail a search.

## Trust boundary

Nothing here changes it. A registry hit is a *suggestion*; installing it still stages into a temp
dir, validates the manifest, prints the real capability summary, and leaves the extension at the
default `prompt-only` tier until `crewcoder extension trust <id> --tier …`. Do not add a
"registry is verified, auto-trust it" path — a registry is just a JSON file someone hosts.
