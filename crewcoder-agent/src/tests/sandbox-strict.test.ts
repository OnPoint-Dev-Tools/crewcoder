import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertStrictIsolationAvailable, runStrictIsolated } from "../core/sandbox-strict.js";
import { detectNetworkIsolationCapabilities } from "../core/sandbox-capabilities.js";

function fakeBinDir(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-strictbin-"));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n", "utf8");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

describe("strict isolation availability gate", () => {
  it("fails closed on non-linux hosts", () => {
    expect(() => assertStrictIsolationAvailable({ platform: "darwin" })).toThrow(/unavailable/i);
  });

  it("fails closed when tooling is missing", () => {
    expect(() => assertStrictIsolationAvailable({
      platform: "linux",
      env: { PATH: fakeBinDir([]) },
      readText: () => "1"
    })).toThrow(/slirp4netns|nft/i);
  });

  it("passes when userns + slirp4netns + nft are present", () => {
    expect(() => assertStrictIsolationAvailable({
      platform: "linux",
      env: { PATH: fakeBinDir(["slirp4netns", "nft"]) },
      readText: (p) => (p.includes("unprivileged_userns_clone") ? "1" : undefined)
    })).not.toThrow();
  });
});

// Real end-to-end executor run. Requires unprivileged userns + slirp4netns + nft,
// so it runs on a capable host (e.g. a dev box or Ubuntu VPS) and skips in CI.
const capable = detectNetworkIsolationCapabilities().canHardIsolate;

describe.skipIf(!capable)("runStrictIsolated (host-gated integration)", () => {
  it("runs a command inside the hardened sandbox and returns its output", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-strict-ws-"));
    const result = await runStrictIsolated({
      command: "echo strict-executor-ok",
      cwd: ws,
      workspaceDir: ws,
      allowedHosts: [],
      timeoutMs: 30_000
    });
    expect(result.backend).toBe("strict");
    expect(result.output).toContain("strict-executor-ok");
    expect(result.timedOut).toBe(false);
  });
});
