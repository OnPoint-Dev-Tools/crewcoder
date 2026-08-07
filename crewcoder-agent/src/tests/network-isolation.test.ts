import { describe, expect, it } from "vitest";
import { buildNftRuleset, buildSlirpArgs, planHardenedExecution, HARDENED_GATEWAY_IP } from "../core/network-isolation.js";

describe("nft egress ruleset", () => {
  it("defaults to drop and permits only loopback + the proxy gateway:port", () => {
    const rules = buildNftRuleset(HARDENED_GATEWAY_IP, 45123);
    expect(rules).toContain("policy drop;");
    expect(rules).toContain('oif "lo" accept');
    expect(rules).toContain("ct state established,related accept");
    expect(rules).toContain("ip daddr 10.0.2.2 tcp dport 45123 accept");
    // No blanket accept and no DNS hole.
    expect(rules).not.toMatch(/policy accept/);
    expect(rules).not.toContain("udp dport 53");
  });
});

describe("slirp4netns argv", () => {
  it("targets the child pid and configures the tap device", () => {
    expect(buildSlirpArgs(4242)).toEqual(["--configure", "--mtu=65520", "4242", "tap0"]);
  });
});

describe("hardened execution plan (nested unshare + bwrap)", () => {
  it("owns the netns via unshare --map-root-user and nests bwrap for fs isolation", () => {
    const plan = planHardenedExecution({
      proxyPort: 5000,
      workspaceDir: "/work",
      nftRulesPath: "/tmp/rules.nft",
      command: "curl https://api.example.com"
    });
    // Outer network owner.
    expect(plan.unshareArgs.slice(0, 3)).toEqual(["--user", "--map-root-user", "--net"]);
    expect(plan.unshareArgs[3]).toBe("/bin/bash");
    const stage = plan.unshareArgs[plan.unshareArgs.length - 1];
    // Firewall-first, then readiness probe, then NESTED bwrap (no --unshare-net).
    expect(stage).toMatch(/nft -f '\/tmp\/rules\.nft' \|\| exit 97/);
    expect(stage).toContain("/dev/tcp/10.0.2.2/5000");
    expect(stage).toContain("exec bwrap ");
    expect(stage).not.toContain("--unshare-net");
    // Correct mount order: ro-bind / before overlaying /dev and /proc.
    expect(stage.indexOf("--ro-bind / /")).toBeLessThan(stage.indexOf("--dev /dev"));
    expect(stage.indexOf("nft -f")).toBeLessThan(stage.indexOf("exec bwrap"));
    expect(stage).toContain("/bin/sh -c 'curl https://api.example.com'");
  });

  it("escapes single quotes in the command safely", () => {
    const plan = planHardenedExecution({
      proxyPort: 5000, workspaceDir: "/work", nftRulesPath: "/tmp/r.nft",
      command: "echo 'hi there'"
    });
    const stage = plan.unshareArgs[plan.unshareArgs.length - 1];
    expect(stage).toContain("'echo '\\''hi there'\\'''");
  });
});
