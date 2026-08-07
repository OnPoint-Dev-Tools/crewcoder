import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectUsernsSupport, detectNetworkIsolationCapabilities } from "../core/sandbox-capabilities.js";

function fakeBinDir(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-capbin-"));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n", "utf8");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function reader(map: Record<string, string>): (p: string) => string | undefined {
  return (p) => map[p];
}

describe("userns detection", () => {
  it("reads the debian/ubuntu clone knob", () => {
    expect(detectUsernsSupport(reader({ "/proc/sys/kernel/unprivileged_userns_clone": "1\n" }))).toBe("enabled");
    expect(detectUsernsSupport(reader({ "/proc/sys/kernel/unprivileged_userns_clone": "0" }))).toBe("disabled");
  });

  it("falls back to max_user_namespaces", () => {
    expect(detectUsernsSupport(reader({ "/proc/sys/user/max_user_namespaces": "15000" }))).toBe("enabled");
    expect(detectUsernsSupport(reader({ "/proc/sys/user/max_user_namespaces": "0" }))).toBe("disabled");
  });

  it("reports unknown when nothing is readable", () => {
    expect(detectUsernsSupport(reader({}))).toBe("unknown");
  });
});

describe("network isolation capabilities", () => {
  it("is unavailable on non-linux hosts", () => {
    const caps = detectNetworkIsolationCapabilities({ platform: "darwin" });
    expect(caps.canHardIsolate).toBe(false);
    expect(caps.reasons.join(" ")).toContain("Linux-only");
  });

  it("engages when userns + slirp4netns + nft are all present", () => {
    const caps = detectNetworkIsolationCapabilities({
      platform: "linux",
      env: { PATH: fakeBinDir(["slirp4netns", "nft"]) },
      readText: reader({ "/proc/sys/kernel/unprivileged_userns_clone": "1" })
    });
    expect(caps.canHardIsolate).toBe(true);
    expect(caps.reasons).toEqual([]);
  });

  it("stays available when userns is unknown (missing sysctl) but tools exist", () => {
    const caps = detectNetworkIsolationCapabilities({
      platform: "linux",
      env: { PATH: fakeBinDir(["slirp4netns", "nft"]) },
      readText: reader({})
    });
    expect(caps.userns).toBe("unknown");
    expect(caps.canHardIsolate).toBe(true);
  });

  it("fails closed when userns is explicitly disabled or tools are missing", () => {
    const disabled = detectNetworkIsolationCapabilities({
      platform: "linux",
      env: { PATH: fakeBinDir(["slirp4netns", "nft"]) },
      readText: reader({ "/proc/sys/kernel/unprivileged_userns_clone": "0" })
    });
    expect(disabled.canHardIsolate).toBe(false);
    expect(disabled.reasons.join(" ")).toContain("user namespaces");

    const noTools = detectNetworkIsolationCapabilities({
      platform: "linux",
      env: { PATH: fakeBinDir([]) },
      readText: reader({ "/proc/sys/kernel/unprivileged_userns_clone": "1" })
    });
    expect(noTools.canHardIsolate).toBe(false);
    expect(noTools.reasons.join(" ")).toContain("slirp4netns");
    expect(noTools.reasons.join(" ")).toContain("nft");
  });
});
