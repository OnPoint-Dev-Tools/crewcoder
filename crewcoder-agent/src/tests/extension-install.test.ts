import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseExtensionSpec,
  summarizeExtensionCapabilities,
  installExtension,
  uninstallExtension,
  updateExtension,
  readInstallRecord
} from "../extensions/extension-install.js";
import { loadCrewCoderExtensions } from "../extensions/extension-loader.js";
import { getExtensionTrustTier, setExtensionTrustTier } from "../extensions/extension-registry.js";
import type { CrewCoderExtensionManifest } from "../extensions/types.js";

let home = "";
let scratch = "";
const originalHome = process.env.CREWCODER_HOME;

async function writeSource(dir: string, manifest: Partial<CrewCoderExtensionManifest> & { id: string }): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const full = { name: manifest.id, version: "0.1.0", crewcoder: { apiVersion: "0.1" }, ...manifest };
  await fs.writeFile(path.join(dir, "crewcoder.extension.json"), JSON.stringify(full, null, 2), "utf8");
  return dir;
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-install-test-"));
  home = path.join(scratch, ".crewcoder");
  process.env.CREWCODER_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalHome;
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("parseExtensionSpec", () => {
  it("resolves GitHub owner/repo shorthand", () => {
    expect(parseExtensionSpec("acme/nextjs-workflows")).toMatchObject({
      kind: "github",
      location: "https://github.com/acme/nextjs-workflows.git",
      ref: undefined,
      subdir: undefined
    });
  });

  it("parses ref and subdir suffixes", () => {
    expect(parseExtensionSpec("acme/pack@v1.2.0#packages/lint")).toMatchObject({
      kind: "github",
      location: "https://github.com/acme/pack.git",
      ref: "v1.2.0",
      subdir: "packages/lint"
    });
  });

  it("treats git URLs and ssh remotes as git sources without eating the user@host", () => {
    expect(parseExtensionSpec("https://gitlab.com/acme/pack.git")).toMatchObject({ kind: "git", ref: undefined });
    expect(parseExtensionSpec("git@github.com:acme/pack.git")).toMatchObject({ kind: "git", location: "git@github.com:acme/pack.git", ref: undefined });
    expect(parseExtensionSpec("git@host:pack.git")).toMatchObject({ kind: "git", location: "git@host:pack.git", ref: undefined });
    expect(parseExtensionSpec("https://user@host/acme/pack.git")).toMatchObject({ location: "https://user@host/acme/pack.git", ref: undefined });
    expect(parseExtensionSpec("https://gitlab.com/acme/pack.git@v1.0")).toMatchObject({ location: "https://gitlab.com/acme/pack.git", ref: "v1.0" });
  });

  it("treats paths as local sources", () => {
    expect(parseExtensionSpec("./local-ext").kind).toBe("local");
    expect(parseExtensionSpec("/tmp/local-ext").kind).toBe("local");
  });

  it("rejects sources that are neither shorthand, URL, nor path", () => {
    expect(() => parseExtensionSpec("not a source")).toThrow(/Unrecognized extension source/);
  });

  it("rejects a subdir that escapes the source root", () => {
    expect(() => parseExtensionSpec("acme/pack#../../etc")).toThrow(/must be a relative path/);
  });
});

describe("summarizeExtensionCapabilities", () => {
  it("flags manifests whose contributions need trust", () => {
    const summary = summarizeExtensionCapabilities({
      id: "x", name: "X", version: "1.0.0", crewcoder: { apiVersion: "0.1" },
      permissions: { network: { allowedHosts: ["api.example.com"] } },
      contributes: { tools: [{ id: "t", title: "T", command: "echo" }], skills: [{ id: "s", title: "S", description: "d", triggers: ["s"] }] }
    });
    expect(summary.requiresTrust).toBe(true);
    expect(summary.tools).toBe(1);
    expect(summary.networkHosts).toEqual(["api.example.com"]);
  });

  it("counts workflows and requires trust only when they contain tool steps", () => {
    const promptOnly = summarizeExtensionCapabilities({
      id: "x", name: "X", version: "1.0.0", crewcoder: { apiVersion: "0.1" },
      contributes: { workflows: [{ id: "w", title: "W", steps: [{ kind: "prompt", prompt: "go" }] }] }
    });
    expect(promptOnly).toMatchObject({ workflows: 1, workflowsWithToolSteps: 0, requiresTrust: false });

    const withTools = summarizeExtensionCapabilities({
      id: "x", name: "X", version: "1.0.0", crewcoder: { apiVersion: "0.1" },
      contributes: { workflows: [{ id: "w", title: "W", steps: [{ kind: "tool", tool: "bash", args: { command: "ls" } }] }] }
    });
    expect(withTools).toMatchObject({ workflows: 1, workflowsWithToolSteps: 1, requiresTrust: true });
  });

  it("does not require trust for prompt-only contributions", () => {
    const summary = summarizeExtensionCapabilities({
      id: "x", name: "X", version: "1.0.0", crewcoder: { apiVersion: "0.1" },
      contributes: { skills: [{ id: "s", title: "S", description: "d", triggers: ["s"] }] }
    });
    expect(summary.requiresTrust).toBe(false);
  });
});

describe("installExtension", () => {
  it("installs a local source into <home>/extensions/<manifest.id> and records provenance", async () => {
    const source = await writeSource(path.join(scratch, "src-pack"), { id: "lint-pack", name: "Lint Pack", version: "2.0.0" });

    const result = await installExtension(source);

    expect(result.id).toBe("lint-pack");
    expect(result.version).toBe("2.0.0");
    expect(result.dir).toBe(path.join(home, "extensions", "lint-pack"));
    expect(fsSync.existsSync(path.join(result.dir, "crewcoder.extension.json"))).toBe(true);

    const record = await readInstallRecord(result.dir);
    expect(record).toMatchObject({ kind: "local", location: source });

    const loaded = await loadCrewCoderExtensions();
    expect(loaded.map((entry) => entry.manifest.id)).toContain("lint-pack");
  });

  it("uses manifest.id for the directory name, not the source directory name", async () => {
    const source = await writeSource(path.join(scratch, "some-repo-name"), { id: "actual-id" });
    const result = await installExtension(source);
    expect(path.basename(result.dir)).toBe("actual-id");
  });

  it("never grants trust on install", async () => {
    const source = await writeSource(path.join(scratch, "tool-pack"), {
      id: "tool-pack",
      contributes: { tools: [{ id: "run", title: "Run", command: "echo" }] }
    });
    const result = await installExtension(source);
    expect(result.capabilities.requiresTrust).toBe(true);
    expect(getExtensionTrustTier("tool-pack")).toBe("prompt-only");
  });

  it("refuses to overwrite an existing install without --force", async () => {
    const source = await writeSource(path.join(scratch, "dup"), { id: "dup" });
    await installExtension(source);
    await expect(installExtension(source)).rejects.toThrow(/already installed/);
  });

  it("backs up the previous copy when forced instead of deleting it", async () => {
    const source = await writeSource(path.join(scratch, "dup2"), { id: "dup2", version: "1.0.0" });
    await installExtension(source);
    await writeSource(path.join(scratch, "dup2"), { id: "dup2", version: "2.0.0" });

    const result = await installExtension(source, { force: true });

    expect(result.version).toBe("2.0.0");
    expect(result.backupDir).toBeDefined();
    expect(fsSync.existsSync(path.join(result.backupDir ?? "", "crewcoder.extension.json"))).toBe(true);
  });

  it("rejects a source with no manifest", async () => {
    const empty = path.join(scratch, "empty");
    await fs.mkdir(empty, { recursive: true });
    await expect(installExtension(empty)).rejects.toThrow(/not a CrewCoder extension/);
  });

  it("rejects a manifest id that is not a safe directory name", async () => {
    const source = path.join(scratch, "evil");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "crewcoder.extension.json"),
      JSON.stringify({ id: "../escaped", name: "Evil", version: "1.0.0", crewcoder: { apiVersion: "0.1" } }),
      "utf8"
    );
    await expect(installExtension(source)).rejects.toThrow(/not a safe directory name/);
  });

  it("rejects an invalid manifest before anything lands in the extensions directory", async () => {
    const source = path.join(scratch, "bad-api");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "crewcoder.extension.json"),
      JSON.stringify({ id: "bad-api", name: "Bad", version: "1.0.0", crewcoder: { apiVersion: "9.9" } }),
      "utf8"
    );
    await expect(installExtension(source)).rejects.toThrow(/apiVersion/);
    expect(fsSync.existsSync(path.join(home, "extensions", "bad-api"))).toBe(false);
  });

  it("installs from a subdirectory of the source", async () => {
    const root = path.join(scratch, "monorepo");
    await writeSource(path.join(root, "packages", "inner"), { id: "inner-pack" });
    const result = await installExtension(root, { subdir: "packages/inner" });
    expect(result.id).toBe("inner-pack");
  });
});

describe("installExtension from a git remote", () => {
  async function makeRepo(): Promise<string> {
    const repo = path.join(scratch, "repo");
    await writeSource(repo, { id: "git-pack", version: "1.0.0" });
    const git = (args: string[]) => new Promise<void>((resolve, reject) => {
      execFile("git", ["-C", repo, ...args], (error) => (error ? reject(error) : resolve()));
    });
    await git(["init", "--quiet", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "commit.gpgsign", "false"]);
    await git(["config", "tag.gpgsign", "false"]);
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "v1"]);
    await git(["tag", "v1.0.0"]);
    await writeSource(repo, { id: "git-pack", version: "2.0.0" });
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "v2"]);
    return repo;
  }

  it("clones the default branch and records the commit sha", async () => {
    const repo = await makeRepo();
    const result = await installExtension(`file://${repo}`);
    expect(result.id).toBe("git-pack");
    expect(result.version).toBe("2.0.0");
    expect(result.record.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fsSync.existsSync(path.join(result.dir, ".git"))).toBe(false);
  });

  it("pins to a tag when given a ref", async () => {
    const repo = await makeRepo();
    const result = await installExtension(`file://${repo}@v1.0.0`);
    expect(result.version).toBe("1.0.0");
    expect(result.record.ref).toBe("v1.0.0");
  });

  it("fails clearly on an unknown ref", async () => {
    const repo = await makeRepo();
    await expect(installExtension(`file://${repo}@v9.9.9`)).rejects.toThrow(/Ref not found|Failed to clone/);
  });
});

describe("updateExtension", () => {
  it("reinstalls from the recorded source", async () => {
    const source = await writeSource(path.join(scratch, "upd"), { id: "upd", version: "1.0.0" });
    await installExtension(source);
    await writeSource(path.join(scratch, "upd"), { id: "upd", version: "1.1.0" });

    const result = await updateExtension("upd");
    expect(result.version).toBe("1.1.0");
  });

  it("fails clearly when the extension has no install record", async () => {
    const dir = path.join(home, "extensions", "handmade");
    await writeSource(dir, { id: "handmade" });
    await expect(updateExtension("handmade")).rejects.toThrow(/no install record/);
  });
});

describe("uninstallExtension", () => {
  it("backs up the directory and clears trust state", async () => {
    const source = await writeSource(path.join(scratch, "gone"), { id: "gone" });
    await installExtension(source);
    setExtensionTrustTier("gone", "trusted");
    expect(getExtensionTrustTier("gone")).toBe("trusted");

    const result = await uninstallExtension("gone");

    expect(fsSync.existsSync(path.join(home, "extensions", "gone"))).toBe(false);
    expect(fsSync.existsSync(path.join(result.backupDir, "crewcoder.extension.json"))).toBe(true);
    expect(result.configCleaned).toBe(true);
    expect(getExtensionTrustTier("gone")).toBe("prompt-only");
  });

  it("fails when the extension is not installed", async () => {
    await expect(uninstallExtension("nope")).rejects.toThrow(/not installed/);
  });
});
