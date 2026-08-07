// Executor for the hardened (strict) network-isolation transport.
//
// Runs the nested orchestration validated by scripts/validate-strict-bwrap.sh:
//   1. Start the loopback filtering proxy for the host allowlist.
//   2. Write the nft ruleset to a temp file.
//   3. spawn `unshare --user --map-root-user --net /bin/bash -c <stage2>` — the
//      outer process owns the network namespace. stage2 applies nft (default
//      drop, permit only the proxy gateway:port), waits for proxy reachability,
//      then execs a nested bwrap for filesystem isolation running the command.
//   4. Attach `slirp4netns` to the outer PID for connectivity.
//   5. Inject HTTP(S)_PROXY pointing at the gateway so cooperating clients route
//      through the proxy (nft blocks everything else, including raw sockets).
//
// Fail-closed: `assertStrictIsolationAvailable` refuses when the host lacks the
// tooling. Callers must gate on it before invoking runStrictIsolated.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startEgressProxy } from "./network-proxy.js";
import { planHardenedExecution, buildSlirpArgs, HARDENED_GATEWAY_IP } from "./network-isolation.js";
import { detectNetworkIsolationCapabilities, type CapabilityProbe } from "./sandbox-capabilities.js";

const MAX_OUTPUT = 120_000;

export type StrictIsolatedInput = {
  command: string;
  cwd: string;
  workspaceDir: string;
  writableDirectories?: string[];
  allowedHosts: string[];
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

export type StrictIsolatedResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  deniedHosts: string[];
  backend: "strict";
};

/** Throw a clear, actionable error when strict isolation is unavailable on this host. */
export function assertStrictIsolationAvailable(probe?: CapabilityProbe): void {
  const caps = detectNetworkIsolationCapabilities(probe);
  if (!caps.canHardIsolate) {
    throw new Error(`Strict network isolation is unavailable on this host: ${caps.reasons.join("; ")}. Fix the host or use sandboxNetworkIsolation=proxy.`);
  }
}

export async function runStrictIsolated(input: StrictIsolatedInput): Promise<StrictIsolatedResult> {
  const proxy = await startEgressProxy(input.allowedHosts);
  const rulesPath = path.join(os.tmpdir(), `crewcoder-nft-${process.pid}-${Date.now()}.nft`);
  const plan = planHardenedExecution({
    proxyPort: proxy.port,
    workspaceDir: input.workspaceDir,
    writableDirectories: input.writableDirectories,
    nftRulesPath: rulesPath,
    command: input.command
  });
  await fs.writeFile(rulesPath, plan.nftRuleset, "utf8");

  // Cooperating clients must be pointed at the proxy via the slirp gateway; nft
  // contains everything else.
  const proxyUrl = `http://${HARDENED_GATEWAY_IP}:${proxy.port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: "127.0.0.1,::1,localhost",
    no_proxy: "127.0.0.1,::1,localhost"
  };

  let slirp: ChildProcess | undefined;
  try {
    return await new Promise<StrictIsolatedResult>((resolve) => {
      const child = spawn("unshare", plan.unshareArgs, { cwd: input.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
      // The unshared bash process holds the netns; attach slirp to its PID.
      if (typeof child.pid === "number") {
        slirp = spawn("slirp4netns", buildSlirpArgs(child.pid), { stdio: "ignore" });
        slirp.on("error", () => { /* surfaced via command failure / no connectivity */ });
      }

      let output = "";
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, input.timeoutMs);
      const abort = () => child.kill("SIGTERM");
      input.signal?.addEventListener("abort", abort, { once: true });
      const append = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (error) => { output += `\n${error.message}`; });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        resolve({ output: output.trim() || "(no output)", exitCode: code, timedOut, deniedHosts: proxy.deniedHosts(), backend: "strict" });
      });
    });
  } finally {
    slirp?.kill("SIGTERM");
    await proxy.close();
    await fs.rm(rulesPath, { force: true });
  }
}
