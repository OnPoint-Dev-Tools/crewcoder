// Planner for the hardened (strict) network-isolation transport.
//
// This is the NESTED design validated end-to-end by
// scripts/validate-strict-bwrap.sh on a rootless Linux host:
//   1. Outer `unshare --user --map-root-user --net` -> a new network namespace
//      owned by a user namespace where we are root, so nft (CAP_NET_ADMIN) and
//      slirp attachment both work. The child starts with only `lo`.
//   2. The outer stage FIRST applies an nft ruleset defaulting to drop, allowing
//      only TCP to the proxy gateway:port (firewall-first = never a window of
//      open egress). The parent attaches `slirp4netns` to the outer pid, adding
//      `tap0` whose gateway (10.0.2.2) maps to the host loopback where the
//      filtering proxy runs. nft pins egress to that one destination, so even a
//      raw socket can only reach the proxy. Raw-socket escape is closed.
//   3. The outer stage waits until the proxy is reachable (slirp attached), then
//      execs `bwrap` NESTED for filesystem isolation (read-only /, read-write
//      workspace) inheriting the locked-down netns. bwrap must NOT --unshare-net
//      here. If slirp never attaches the command runs with no egress at all ->
//      still fail-closed.
//
// bwrap alone cannot do this: it does not map to root-in-userns, so nft gets
// EPERM and slirp cannot setns. Hence the outer unshare owns the network.
//
// This module only *plans* (produces argv + ruleset text). It is pure so the
// exact commands and firewall rules are unit-reviewable. The executor that runs
// them lives separately and is validated per-host (scripts/validate-strict-*.sh).

export const HARDENED_GATEWAY_IP = "10.0.2.2"; // slirp4netns default host-loopback gateway
export const HARDENED_TAP_DEVICE = "tap0";
export const HARDENED_MTU = 65520;

export type HardenedPlanInput = {
  proxyPort: number;
  /** Absolute workspace path bound read-write inside the sandbox. */
  workspaceDir: string;
  /** Additional session roots bound read-write inside the sandbox. */
  writableDirectories?: string[];
  /** Host path where the nft ruleset file is written (read directly by the outer stage). */
  nftRulesPath: string;
  /** The command the child ultimately runs (via `/bin/sh -c`). */
  command: string;
  /** Seconds to wait for proxy reachability before proceeding (fail-closed). */
  proxyWaitSeconds?: number;
};

export type HardenedPlan = {
  /** unshare argv (excluding the leading "unshare"); the outer netns owner. */
  unshareArgs: string[];
  /** nft ruleset text to write at nftRulesPath before spawning. */
  nftRuleset: string;
  gatewayIp: string;
  proxyPort: number;
};

const DEFAULT_PROXY_WAIT_SECONDS = 10;

/**
 * Build the nftables ruleset applied inside the child's network namespace.
 * Default-drop egress; permit only loopback and TCP to the proxy gateway:port.
 * No DNS is allowed out because name resolution happens in the parent-side proxy.
 */
export function buildNftRuleset(gatewayIp: string, proxyPort: number): string {
  return [
    "flush ruleset",
    "table inet crewcoder_egress {",
    "  chain output {",
    "    type filter hook output priority 0; policy drop;",
    "    oif \"lo\" accept",
    "    ct state established,related accept",
    `    ip daddr ${gatewayIp} tcp dport ${proxyPort} accept`,
    "  }",
    "}",
    ""
  ].join("\n");
}

/** slirp4netns argv (excluding the leading "slirp4netns") for a target child PID. */
export function buildSlirpArgs(childPid: number, device = HARDENED_TAP_DEVICE, mtu = HARDENED_MTU): string[] {
  // Host loopback stays enabled so the child can reach the parent proxy via the
  // gateway; nft restricts that to the single proxy port. A bare numeric pid uses
  // the default pid netns type (matches the validated invocation).
  return ["--configure", `--mtu=${mtu}`, String(childPid), device];
}

export function planHardenedExecution(input: HardenedPlanInput): HardenedPlan {
  const stage2 = buildOuterStageScript(input);
  // The outer process owns the network namespace; the parent attaches slirp to
  // its PID. bash is required for the /dev/tcp readiness probe.
  const unshareArgs = ["--user", "--map-root-user", "--net", "/bin/bash", "-c", stage2];
  return { unshareArgs, nftRuleset: buildNftRuleset(HARDENED_GATEWAY_IP, input.proxyPort), gatewayIp: HARDENED_GATEWAY_IP, proxyPort: input.proxyPort };
}

function buildOuterStageScript(input: HardenedPlanInput): string {
  const waitSeconds = input.proxyWaitSeconds ?? DEFAULT_PROXY_WAIT_SECONDS;
  const tries = Math.max(1, Math.round(waitSeconds / 0.2));
  const ws = shSingleQuote(input.workspaceDir);
  const externalBinds = (input.writableDirectories ?? [])
    .map((directory) => `--bind ${shSingleQuote(directory)} ${shSingleQuote(directory)}`)
    .join(" ");
  // Firewall-first (default drop) BEFORE any egress is possible, then wait for
  // the proxy hole to open once the parent attaches slirp, then hand off to a
  // NESTED bwrap for filesystem isolation. Mount order: `--ro-bind / /` first,
  // then overlay a writable /dev and /proc on top.
  const bwrap = [
    "exec bwrap --die-with-parent --unshare-pid --unshare-ipc --unshare-uts",
    "--ro-bind / / --dev /dev --proc /proc",
    `--bind ${ws} ${ws}${externalBinds ? ` ${externalBinds}` : ""} --chdir ${ws}`,
    `-- /bin/sh -c ${shSingleQuote(input.command)}`
  ].join(" ");
  return [
    "ip link set lo up 2>/dev/null || true",
    `nft -f ${shSingleQuote(input.nftRulesPath)} || exit 97`,
    `for _ in $(seq 1 ${tries}); do (exec 3<>/dev/tcp/${HARDENED_GATEWAY_IP}/${input.proxyPort}) 2>/dev/null && break; sleep 0.2; done`,
    bwrap
  ].join("\n");
}

function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
