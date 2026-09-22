import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { compareVersions, releaseFiles, stableVersionParts, updateReleaseMetadata } = require("../scripts/release.cjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("release automation", () => {
  it("commits version API baselines without including the independent TUI manifest", () => {
    expect(releaseFiles).toContain("crewcoder-client/api/version.d.ts");
    expect(releaseFiles).toContain("crewcoder-sdk/api/version.d.ts");
    expect(releaseFiles).not.toContain("crewcoder-tui/package.json");
  });

  it("accepts stable semantic versions and compares them numerically", () => {
    expect(stableVersionParts("0.2.3")).toEqual([0, 2, 3]);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(() => stableVersionParts("v0.2.3")).toThrow(/without a leading v/);
    expect(() => stableVersionParts("0.2.3-beta.1")).toThrow(/stable semantic version/);
  });

  it("updates the coordinated release group while preserving the TUI version", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-release-test-"));
    temporaryDirectories.push(repositoryRoot);
    const manifests = {
      "package.json": { name: "crewcoder", version: "0.1.0", dependencies: { "@onpoint-dev-tools/crewcoder-agent": "0.1.0", "@onpoint-dev-tools/crewcoder-tui": "0.0.9" } },
      "crewcoder-agent/package.json": { name: "@onpoint-dev-tools/crewcoder-agent", version: "0.1.0", dependencies: { "@openai/codex": "0.146.1" } },
      "crewcoder-client/package.json": { name: "@onpoint-dev-tools/crewcoder-client", version: "0.1.0" },
      "crewcoder-sdk/package.json": { name: "@onpoint-dev-tools/crewcoder-sdk", version: "0.1.0", dependencies: { "@onpoint-dev-tools/crewcoder-agent": "0.1.0", "@onpoint-dev-tools/crewcoder-client": "0.1.0" } },
      "crewcoder-tui/package.json": { name: "@onpoint-dev-tools/crewcoder-tui", version: "0.0.9" }
    };
    for (const [relativePath, manifest] of Object.entries(manifests)) {
      const filePath = path.join(repositoryRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const constants = {
      "crewcoder-agent/src/core/version.ts": "export const CREWCODER_VERSION = \"0.1.0\" as const;\n",
      "crewcoder-client/src/version.ts": "export const CREWCODER_CLIENT_VERSION = \"0.1.0\" as const;\n",
      "crewcoder-sdk/src/version.ts": "export const CREWCODER_SDK_VERSION = \"0.1.0\" as const;\n"
    };
    for (const [relativePath, source] of Object.entries(constants)) {
      const filePath = path.join(repositoryRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source);
    }

    updateReleaseMetadata(repositoryRoot, "0.2.3", "0.155.1");

    for (const relativePath of Object.keys(manifests).filter((relativePath) => relativePath !== "crewcoder-tui/package.json")) {
      expect(JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8")).version).toBe("0.2.3");
    }
    expect(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "crewcoder-tui/package.json"), "utf8")).version).toBe("0.0.9");
    const rootManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    expect(rootManifest.dependencies).toMatchObject({
      "@onpoint-dev-tools/crewcoder-agent": "0.2.3",
      "@onpoint-dev-tools/crewcoder-tui": "0.0.9"
    });
    const sdkManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "crewcoder-sdk/package.json"), "utf8"));
    expect(sdkManifest.dependencies).toMatchObject({
      "@onpoint-dev-tools/crewcoder-agent": "0.2.3",
      "@onpoint-dev-tools/crewcoder-client": "0.2.3"
    });
    const agentManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "crewcoder-agent/package.json"), "utf8"));
    expect(agentManifest.dependencies["@openai/codex"]).toBe("0.155.1");
    for (const relativePath of Object.keys(constants)) {
      expect(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8")).toContain('"0.2.3"');
    }
  });
});
