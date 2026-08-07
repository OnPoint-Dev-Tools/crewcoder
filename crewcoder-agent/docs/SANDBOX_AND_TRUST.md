# Sandbox, Network Egress, and Trust Tiers

Phase 1 security substrate. Three coordinated features that contain the blast
radius of tool execution and extensions.

## 1. Sandboxed approval tier

A new approval mode sits between `review` and `full-access`:

```bash
crewcoder run --approval sandboxed "refactor the parser"
```

In `sandboxed` mode mutating shell/extension commands run inside an OS-level
sandbox instead of prompting for each call. Backends, in preference order:

| Backend | Requirement | Status |
|---------|-------------|--------|
| bubblewrap | `bwrap` on PATH (Linux) | fully wired |
| docker | `docker` on PATH | best-effort argv |
| none | — | **fail closed** |

The sandbox gives a read-only view of the filesystem, a read-write bind of the
workspace (`cwd`) plus `$TMPDIR`, and **network disabled by default**
(`--unshare-net` / `--network none`).

**Fail closed:** if `sandboxed` is requested and no backend is available, the
command is refused with a clear error rather than run unsandboxed. Outright
dangerous commands (`rm -rf`, `mkfs`, …) remain blocked as before.

Force-disable detection for tests/CI with `CREWCODER_SANDBOX_BACKEND=none`.

Implementation: `src/core/sandbox.ts`, consumed by `src/tools/bash.ts` and
`src/extensions/extension-tools.ts` via `ToolContext.sandbox`.

## 2. Network egress allowlist per extension

Extensions declare outbound hosts in their manifest. Egress is denied unless
declared:

```json
{
  "id": "my-ext",
  "permissions": { "network": { "allowedHosts": ["api.example.com", "*.trusted.dev"] } }
}
```

Patterns support exact hosts, leading wildcards (`*.example.com`, also matches
the apex), and `*`. Enforcement points today: sandboxed-tier extension command
tools and the sandboxed `bash` tier.

**How it's enforced — filtering proxy.** With an empty allowlist the sandbox
isolates the network entirely (`--unshare-net`). With a non-empty allowlist, a
per-execution HTTP/HTTPS forward proxy (`src/core/network-proxy.ts`) is started on
loopback and the sandboxed child is given `HTTP(S)_PROXY`/`ALL_PROXY` env pointing
at it. The proxy permits connections only to allowlisted hosts (HTTP requests and
HTTPS `CONNECT` tunnels) and returns `403` for everything else; rejected hosts are
recorded for observability. The proxy is torn down when the command exits.

**Scope / limits.** This constrains proxy-respecting clients (curl, wget, git,
npm, Node fetch/undici, most SDKs) — the common case. It is not a kernel-level
firewall: because bubblewrap shares the host net namespace when an allowlist is
present (so the loopback proxy is reachable), a process that opens raw sockets and
ignores the proxy env can still reach the network. True containment needs
slirp/veth routing (a future backend). Docker cannot reach the host loopback proxy,
so per-host allowlisting under docker **fails closed** with a clear error — use
bubblewrap, or an empty allowlist for full isolation.

Config-level allowlist for the sandboxed `bash` tier:

```bash
crewcoder config set sandboxAllowedHosts "api.example.com,*.internal.net"
```

Helpers: `src/core/network-policy.ts` (`isHostAllowed`, `hostFromUrl`,
`normalizeAllowedHosts`) — reusable by any future egress point.

## 2b. Strict network isolation (bare Linux VPS) — substrate landed, executor pending

The proxy in §2 enforces egress for proxy-respecting clients but shares the host
network namespace, so a raw socket can bypass it. The **strict** transport closes
that on a bare rootless Linux host, using a **nested** design (validated
end-to-end by `scripts/validate-strict-bwrap.sh`):

1. Outer `unshare --user --map-root-user --net` creates a new network namespace
   owned by a user namespace where we are root — so `nft` (needs CAP_NET_ADMIN)
   and slirp attachment both work. The child starts with only `lo`.
2. The outer stage applies an `nft` ruleset **first** (default-drop, permit only
   TCP to the proxy gateway:port). Firewall-first = no window of open egress. The
   parent attaches `slirp4netns` to the outer PID (adds `tap0`, gateway `10.0.2.2`
   → host loopback where the proxy runs). Even a raw socket has exactly one
   reachable destination: the proxy. Raw-socket escape closed.
3. The outer stage waits for the proxy hole to open, then execs `bwrap` **nested**
   for filesystem isolation (read-only `/`, read-write workspace), inheriting the
   locked-down netns (bwrap does *not* `--unshare-net`).

Why nested: bwrap alone does not map to root-in-userns, so `nft` gets EPERM and
slirp cannot `setns` into the namespace. The outer `unshare --map-root-user` is
what makes both work.

**Requirements** (auto-detected — `src/core/sandbox-capabilities.ts`): Linux +
unprivileged user namespaces + `slirp4netns` + `nft`. Typical Ubuntu/Debian VPS
qualify (`apt install slirp4netns nftables`; userns is on by default). Docker
deployments do **not** use this path — the container boundary provides the netns,
so egress is locked at the container/network layer (Phase 3 deploy tooling).

**Status: wired.** Capability detection (`sandbox-capabilities.ts`), the pure
**planner** (`src/core/network-isolation.ts`), and the **executor**
(`src/core/sandbox-strict.ts` — spawns `unshare`, attaches `slirp4netns`, streams
output, injects proxy env, cleans up) are all implemented. The `bash` tool routes
to the executor when strict mode is on; it **fails closed** via
`assertStrictIsolationAvailable()` when the host can't hard-isolate. The design is
validated end-to-end on real hardware by the two scripts above, and
`src/tests/sandbox-strict.test.ts` runs the executor for real on capable hosts
(and skips in CI, which has no userns/slirp/nft).

### Enabling strict mode

```bash
crewcoder config set sandboxNetworkIsolation strict   # default is "proxy"
crewcoder config set sandboxAllowedHosts "api.github.com,*.npmjs.org"
crewcoder run --approval sandboxed "install deps and run tests"
```

In strict mode the `bash` tool runs each command in the hardened netns: `nft`
pins egress to the loopback proxy, `HTTP(S)_PROXY` routes cooperating clients
through it (gateway `10.0.2.2`), and the proxy enforces `sandboxAllowedHosts`.
Raw-socket attempts to any other host are dropped by the kernel. On a host that
can't hard-isolate, the run errors instead of silently falling back. Extension
sandboxed-tier tools still use the proxy path (§2) for now.

### Validating a host before enabling the executor

Two **standalone** self-checks (no CrewCoder install, no root) prove containment
on a host — an external raw socket must be **blocked**, the proxy hole must be
**reachable**:

- `scripts/validate-strict-sandbox.sh` — the isolation *primitive* (netns +
  slirp4netns + the nft ruleset).
- `scripts/validate-strict-bwrap.sh` — the **exact executor orchestration**
  (outer `unshare --map-root-user --net` + slirp + nested bwrap, firewall-first),
  mirroring `planHardenedExecution()`.

Both PASS on a stock rootless Linux host with the tooling installed (verified on
Arch; the same primitives ship on Ubuntu 22.04+).

```bash
# on the target host (VPS, VM, WSL2, or this dev box)
sudo pacman -S --needed bubblewrap slirp4netns nftables   # Arch
# sudo apt install -y bubblewrap slirp4netns nftables      # Ubuntu/Debian
bash crewcoder-agent/scripts/validate-strict-sandbox.sh
# exit 0 = PASS (host can contain raw-socket egress; executor is safe to enable)
# exit 1 = FAIL (keep CrewCoder on the proxy path here)
# exit 2 = prerequisites missing (script prints the install command)
```

Once a target class of hosts passes (e.g. stock Ubuntu 22.04+ VPS), the executor
is wired against that proven baseline — most naturally as part of Phase 3 deploy
tooling, where the VPS/Docker image is under our control.

## 3. Trust tiers

Replaces the binary trusted/untrusted model with three tiers:

| Tier | Tools | Modules / hooks / renderers / live UI | Prompt fragments |
|------|-------|----------------------------------------|------------------|
| `trusted` | full host access | yes | yes |
| `sandboxed` | command tools run in the sandbox | no | yes |
| `prompt-only` (default) | no | no | yes (skills / promptPacks / commands) |

```bash
crewcoder extension trust <id>                 # trusted (default)
crewcoder extension trust <id> --tier sandboxed
crewcoder extension untrust <id>               # back to prompt-only
crewcoder extension tier <id>                  # show effective tier
```

Storage stays backward compatible: `config.trustedExtensions` is the `trusted`
list, `config.sandboxedExtensions` is the `sandboxed` list, anything else enabled
is `prompt-only`. In-process module tools still require the `trusted` tier plus
`allowExtensionTools`; they cannot be sandboxed as subprocesses.

Helpers: `src/core/trust.ts` (`getTrustTier`, `getExtensionCapabilities`,
`isExtensionTrusted`).

## Tests

`src/tests/{sandbox,network-policy,network-proxy,trust,bash-sandbox}.test.ts` and
the sandboxed-tier case in `src/tests/extension-tools.test.ts`. The proxy suite
covers HTTP allow/deny, HTTPS `CONNECT` tunnel/deny, and the sandbox network
setup/teardown lifecycle.
