// Real sandbox execution tier (Feature 1).
//
// When approval mode is "sandboxed", mutating shell/extension commands run inside
// an OS-level sandbox with a read-only view of the filesystem, a writable workspace,
// and network disabled unless an explicit host allowlist is present. We fail closed:
// if no sandbox backend is available the command is refused rather than run raw.
//
// Backends, in preference order:
//   - bubblewrap (`bwrap`)  Linux user-namespace sandbox. Fully wired.
//   - docker                Container fallback. Best-effort argv construction.
//   - none                  No sandbox available -> callers must refuse to run.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ApprovalMode } from "./approval.js";
import { readConfig } from "./config.js";
import { normalizeAllowedHosts } from "./network-policy.js";
import { startEgressProxy, type NetworkProxy } from "./network-proxy.js";

export type SandboxBackend = "bubblewrap" | "docker" | "none";

export type SandboxNetworkPolicy = {
  /** "none" fully isolates the network; "open" leaves it up (host allowlist is advisory for now). */
  mode: "none" | "open";
  allowedHosts: string[];
};

export type SandboxPolicy = {
  enabled: boolean;
  /** Primary workspace granted read-write inside the sandbox. */
  workspaceDir: string;
  /** Session-scoped external roots also granted read-write. */
  writableDirectories?: string[];
  network: SandboxNetworkPolicy;
  /**
   * "proxy" (default): shared netns + loopback filtering proxy (enforces egress
   * for proxy-respecting clients). "strict": hardened netns isolation via
   * unshare+slirp4netns+nft (raw-socket egress physically blocked; Linux only,
   * capability-gated, fail-closed).
   */
  networkIsolation?: "proxy" | "strict";
};

export type SandboxContext = {
  policy: SandboxPolicy;
  backend: SandboxBackend;
};

export type WrappedCommand = {
  file: string;
  args: string[];
  /** True only when the command is actually wrapped by a real backend. */
  sandboxed: boolean;
  backend: SandboxBackend;
  note?: string;
};

const DOCKER_IMAGE = "alpine:3.20";

export function hasExecutable(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const rawPath = env.PATH ?? "";
  if (!rawPath) return false;
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

/** Detect the best available sandbox backend on this host. */
export function detectSandboxBackend(env: NodeJS.ProcessEnv = process.env): SandboxBackend {
  if (env.CREWCODER_SANDBOX_BACKEND === "none") return "none";
  if (os.platform() === "linux" && hasExecutable("bwrap", env)) return "bubblewrap";
  if (hasExecutable("docker", env)) return "docker";
  return "none";
}

function networkAllowsEgress(network: SandboxNetworkPolicy): boolean {
  return network.mode === "open" || network.allowedHosts.length > 0;
}

function bubblewrapArgs(policy: SandboxPolicy): string[] {
  const workspace = path.resolve(policy.workspaceDir);
  // Mount order matters: bind the read-only root FIRST, then overlay a writable
  // /dev and /proc on top. Doing --dev/--proc before --ro-bind / / clobbers them
  // with the read-only host copies (breaks /dev/null etc.).
  const tmp = path.join(os.tmpdir());
  const args = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--bind", workspace, workspace,
    ...(policy.writableDirectories ?? []).flatMap((directory) => ["--bind", path.resolve(directory), path.resolve(directory)]),
    "--bind", tmp, tmp,
    "--chdir", workspace
  ];
  if (!networkAllowsEgress(policy.network)) args.push("--unshare-net");
  return args;
}

function dockerArgs(policy: SandboxPolicy): string[] {
  const workspace = path.resolve(policy.workspaceDir);
  const args = [
    "run", "--rm", "-i", "--workdir", workspace,
    "--volume", `${workspace}:${workspace}`,
    ...(policy.writableDirectories ?? []).flatMap((directory) => ["--volume", `${path.resolve(directory)}:${path.resolve(directory)}`])
  ];
  if (!networkAllowsEgress(policy.network)) args.push("--network", "none");
  args.push(DOCKER_IMAGE);
  return args;
}

function egressNote(policy: SandboxPolicy, backend: SandboxBackend): string | undefined {
  if (policy.network.allowedHosts.length === 0) return undefined;
  if (backend === "docker") {
    return `network allowlist (${policy.network.allowedHosts.join(", ")}) is not enforced under docker; use bubblewrap for per-host egress filtering.`;
  }
  return `network egress restricted to: ${policy.network.allowedHosts.join(", ")} (enforced via loopback filtering proxy for proxy-respecting clients).`;
}

/** Wrap a `/bin/sh -c <command>` shell command for the given backend. */
export function wrapShellCommand(command: string, policy: SandboxPolicy, backend: SandboxBackend): WrappedCommand {
  if (!policy.enabled || backend === "none") {
    return { file: command, args: [], sandboxed: false, backend };
  }
  if (backend === "bubblewrap") {
    return { file: "bwrap", args: [...bubblewrapArgs(policy), "--", "/bin/sh", "-c", command], sandboxed: true, backend, note: egressNote(policy, backend) };
  }
  return { file: "docker", args: [...dockerArgs(policy), "/bin/sh", "-c", command], sandboxed: true, backend, note: egressNote(policy, backend) };
}

/** Wrap an already-split argv (no shell) for the given backend. */
export function wrapArgvCommand(file: string, argv: string[], policy: SandboxPolicy, backend: SandboxBackend): WrappedCommand {
  if (!policy.enabled || backend === "none") {
    return { file, args: argv, sandboxed: false, backend };
  }
  if (backend === "bubblewrap") {
    return { file: "bwrap", args: [...bubblewrapArgs(policy), "--", file, ...argv], sandboxed: true, backend, note: egressNote(policy, backend) };
  }
  return { file: "docker", args: [...dockerArgs(policy), file, ...argv], sandboxed: true, backend, note: egressNote(policy, backend) };
}

/**
 * Build the sandbox context for a run, or undefined when sandboxing is not requested.
 * Network defaults to fully isolated; a configured host allowlist opens egress.
 */
export function buildSandboxContext(approvalMode: ApprovalMode, cwd: string, externalDirectories: readonly string[] = []): SandboxContext | undefined {
  if (approvalMode !== "sandboxed") return undefined;
  const config = readConfig();
  const allowedHosts = normalizeAllowedHosts(config.sandboxAllowedHosts);
  return {
    policy: {
      enabled: true,
      workspaceDir: cwd,
      writableDirectories: externalDirectories.map((directory) => path.resolve(directory)),
      network: { mode: allowedHosts.length > 0 ? "open" : "none", allowedHosts },
      networkIsolation: config.sandboxNetworkIsolation
    },
    backend: detectSandboxBackend()
  };
}

export type SandboxNetworkSetup = {
  /** Extra environment variables to inject into the sandboxed child (proxy config). */
  env: Record<string, string>;
  proxy?: NetworkProxy;
  /** Tear down any proxy started for this execution. Always safe to call. */
  dispose: () => Promise<void>;
};

const NOOP_NETWORK_SETUP: SandboxNetworkSetup = { env: {}, dispose: async () => {} };

/**
 * Start the per-execution egress proxy when the policy carries a host allowlist,
 * and return the proxy env to inject plus a disposer. When there is no allowlist
 * (fully isolated network) or sandboxing is disabled, returns a no-op setup.
 *
 * bubblewrap shares the host network namespace when an allowlist is present, so a
 * loopback proxy is reachable. Docker containers cannot reach the host loopback
 * proxy, so per-host allowlisting under docker is refused (fail closed).
 */
export async function prepareSandboxNetwork(policy: SandboxPolicy, backend: SandboxBackend): Promise<SandboxNetworkSetup> {
  if (!policy.enabled || policy.network.allowedHosts.length === 0) return NOOP_NETWORK_SETUP;
  if (backend === "docker") {
    throw new Error("Per-host network egress allowlists are not supported under the docker sandbox backend yet. Use bubblewrap, or an empty allowlist for full network isolation.");
  }
  const proxy = await startEgressProxy(policy.network.allowedHosts);
  const env = {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    ALL_PROXY: proxy.url,
    all_proxy: proxy.url,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1"
  };
  return { env, proxy, dispose: () => proxy.close() };
}

/** Human-readable error when a sandbox is required but unavailable (fail closed). */
export const SANDBOX_UNAVAILABLE_MESSAGE =
  "Sandboxed approval mode requires a sandbox backend (bubblewrap `bwrap` on Linux, or `docker`). None was found on PATH, so the command was refused instead of running unsandboxed.";
