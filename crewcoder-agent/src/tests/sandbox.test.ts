import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectSandboxBackend, wrapShellCommand, wrapArgvCommand, type SandboxPolicy } from "../core/sandbox.js";

function fakeBinDir(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-"));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n", "utf8");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    enabled: true,
    workspaceDir: "/work/space",
    network: { mode: "none", allowedHosts: [] },
    ...overrides
  };
}

describe("sandbox backend detection", () => {
  it("honors the forced-off override", () => {
    expect(detectSandboxBackend({ PATH: fakeBinDir(["bwrap"]), CREWCODER_SANDBOX_BACKEND: "none" })).toBe("none");
  });

  it("prefers bubblewrap on linux, else docker, else none", () => {
    const bwrapDir = fakeBinDir(["bwrap", "docker"]);
    const dockerDir = fakeBinDir(["docker"]);
    const emptyDir = fakeBinDir([]);
    const expected = os.platform() === "linux" ? "bubblewrap" : "docker";
    expect(detectSandboxBackend({ PATH: bwrapDir })).toBe(expected);
    expect(detectSandboxBackend({ PATH: dockerDir })).toBe("docker");
    expect(detectSandboxBackend({ PATH: emptyDir })).toBe("none");
  });
});

describe("sandbox command wrapping", () => {
  it("returns the raw command unsandboxed when no backend is available", () => {
    const wrapped = wrapShellCommand("ls", policy(), "none");
    expect(wrapped.sandboxed).toBe(false);
    expect(wrapped.file).toBe("ls");
  });

  it("wraps shell commands with bubblewrap and isolates the network by default", () => {
    const wrapped = wrapShellCommand("npm test", policy(), "bubblewrap");
    expect(wrapped.sandboxed).toBe(true);
    expect(wrapped.file).toBe("bwrap");
    expect(wrapped.args).toContain("--unshare-net");
    expect(wrapped.args.slice(-3)).toEqual(["/bin/sh", "-c", "npm test"]);
    expect(wrapped.args).toContain("/work/space");
  });

  it("binds session external directories read-write", () => {
    const external = "/shared/library";
    const bubblewrap = wrapShellCommand("pwd", policy({ writableDirectories: [external] }), "bubblewrap");
    const docker = wrapShellCommand("pwd", policy({ writableDirectories: [external] }), "docker");
    expect(bubblewrap.args).toContain(external);
    expect(docker.args).toContain(`${external}:${external}`);
  });

  it("shares the network when an allowlist is present and notes proxy enforcement", () => {
    const wrapped = wrapShellCommand("curl x", policy({ network: { mode: "open", allowedHosts: ["api.example.com"] } }), "bubblewrap");
    expect(wrapped.args).not.toContain("--unshare-net");
    expect(wrapped.note).toContain("api.example.com");
    expect(wrapped.note).toContain("proxy");
  });

  it("wraps argv commands for docker with network none", () => {
    const wrapped = wrapArgvCommand("node", ["-e", "1"], policy(), "docker");
    expect(wrapped.file).toBe("docker");
    expect(wrapped.args).toContain("--network");
    expect(wrapped.args.slice(-3)).toEqual(["node", "-e", "1"]);
  });
});
