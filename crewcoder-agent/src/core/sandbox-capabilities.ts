// Host capability detection for the hardened network-isolation backend.
//
// Airtight per-host egress (no raw-socket escape) on a bare Linux VPS needs three
// things present on the machine where CrewCoder runs the sandboxed command:
//   1. unprivileged user namespaces enabled (to create a rootless net namespace)
//   2. `slirp4netns` on PATH (userspace connectivity for the isolated namespace)
//   3. `nft` on PATH (in-namespace firewall so only the proxy is reachable)
//
// This module is pure and fully dependency-injectable so it is unit-testable
// without those tools actually being installed. It decides *whether* the hardened
// path can engage; the orchestration lives in the sandbox transport.

import os from "node:os";
import fs from "node:fs";
import { hasExecutable } from "./sandbox.js";

export type UsernsSupport = "enabled" | "disabled" | "unknown";

export type NetworkIsolationCapabilities = {
  platform: NodeJS.Platform;
  userns: UsernsSupport;
  slirp4netns: boolean;
  nft: boolean;
  /** True only when every requirement for real raw-socket containment is met. */
  canHardIsolate: boolean;
  /** Human-readable reasons the hardened path is unavailable (empty when it is). */
  reasons: string[];
};

export type CapabilityProbe = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Reads a sysctl-style file, returning its text or undefined if unreadable. */
  readText?: (path: string) => string | undefined;
};

function defaultReadText(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Detect unprivileged user-namespace support.
 * Debian/Ubuntu expose `kernel.unprivileged_userns_clone` (1 = enabled).
 * Where that knob is absent, `user.max_user_namespaces > 0` indicates support.
 * Anything we cannot read is reported as "unknown" rather than assumed.
 */
export function detectUsernsSupport(readText: (path: string) => string | undefined = defaultReadText): UsernsSupport {
  const clone = readText("/proc/sys/kernel/unprivileged_userns_clone");
  if (clone !== undefined) return clone.trim() === "1" ? "enabled" : "disabled";
  const max = readText("/proc/sys/user/max_user_namespaces");
  if (max !== undefined) {
    const value = Number(max.trim());
    if (Number.isFinite(value)) return value > 0 ? "enabled" : "disabled";
  }
  return "unknown";
}

export function detectNetworkIsolationCapabilities(probe: CapabilityProbe = {}): NetworkIsolationCapabilities {
  const platform = probe.platform ?? os.platform();
  const env = probe.env ?? process.env;
  const readText = probe.readText ?? defaultReadText;

  const userns = platform === "linux" ? detectUsernsSupport(readText) : "disabled";
  const slirp4netns = platform === "linux" && hasExecutable("slirp4netns", env);
  const nft = platform === "linux" && hasExecutable("nft", env);

  const reasons: string[] = [];
  if (platform !== "linux") reasons.push(`hardened network isolation is Linux-only (host is ${platform})`);
  if (platform === "linux" && userns === "disabled") reasons.push("unprivileged user namespaces are disabled (sysctl kernel.unprivileged_userns_clone=0)");
  if (platform === "linux" && !slirp4netns) reasons.push("slirp4netns is not installed (apt install slirp4netns)");
  if (platform === "linux" && !nft) reasons.push("nft is not installed (apt install nftables)");

  // "unknown" userns does not block: on modern kernels the knob is often absent
  // while the feature is on. We proceed and fail closed at runtime if creation
  // actually fails, rather than refusing on a missing sysctl file.
  const canHardIsolate = platform === "linux" && userns !== "disabled" && slirp4netns && nft;

  return { platform, userns, slirp4netns, nft, canHardIsolate, reasons };
}
