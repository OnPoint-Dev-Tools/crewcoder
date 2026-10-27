import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore, ARTIFACT_LIMITS, parseArtifactWrite } from "../core/artifact-store.js";

describe("artifact storage", () => {
  let home: string;
  const input = { title: "Chart", format: "html" as const, content: "<button>Run</button><script>window.example = true</script>" };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-artifacts-"));
    vi.stubEnv("CREWCODER_HOME", home);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("stores inert UTF-8 source privately and restores it through a new store", () => {
    const store = new ArtifactStore("session_one");
    const artifact = store.write(input);
    expect(artifact).toMatchObject({ ...input, revision: 1, mimeType: "text/html", byteSize: Buffer.byteLength(input.content) });
    expect(new ArtifactStore("session_one").read(artifact.id)).toEqual(artifact);
    expect(store.list()).toEqual([expect.objectContaining({ id: artifact.id, revision: 1 })]);
    expect(store.list()[0]).not.toHaveProperty("content");
    expect(fs.statSync(path.join(home, "artifacts", "session_one", artifact.id + ".json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "artifacts", "session_one")).mode & 0o777).toBe(0o700);
  });

  it("requires the current revision and preserves content on conflicting edits", () => {
    const store = new ArtifactStore("session_one");
    const created = store.write(input);
    const edited = store.write({ ...input, content: "edited", id: created.id, expectedRevision: 1 });
    expect(edited).toMatchObject({ revision: 2, content: "edited", createdAt: created.createdAt });
    expect(() => store.write({ ...input, id: created.id, expectedRevision: 1 })).toThrow("Artifact changed");
    expect(store.read(created.id)).toEqual(edited);
    expect(() => store.write({ ...input, id: created.id })).toThrow("expectedRevision");
  });

  it("isolates sessions and rejects traversal and invalid input", () => {
    const created = new ArtifactStore("session_one").write(input);
    expect(() => new ArtifactStore("session_two").read(created.id)).toThrow("not found");
    for (const id of ["../outside", "/etc/passwd", "", "artifact_../secret"]) {
      expect(() => new ArtifactStore("session_one").read(id)).toThrow("Invalid artifact id");
    }
    expect(() => new ArtifactStore("../outside")).toThrow("Invalid session id");
    for (const raw of [{ ...input, title: "" }, { ...input, title: "bad\nname" }, { ...input, format: "exe" }, { ...input, content: 1 }, { ...input, expectedRevision: 1 }]) {
      expect(() => parseArtifactWrite(raw)).toThrow();
    }
    expect(() => parseArtifactWrite({ ...input, id: created.id, expectedRevision: Infinity })).toThrow();
  });

  it("checks UTF-8 byte limits and prevents exceeding count or total content quotas", () => {
    const store = new ArtifactStore("session_one");
    expect(() => store.write({ ...input, content: "é".repeat(ARTIFACT_LIMITS.maxContentBytes / 2 + 1) })).toThrow("512 KiB");
    const full = "x".repeat(ARTIFACT_LIMITS.maxContentBytes);
    for (let index = 0; index < ARTIFACT_LIMITS.maxSessionBytes / ARTIFACT_LIMITS.maxContentBytes; index++) store.write({ ...input, content: full });
    expect(() => store.write({ ...input, content: "x" })).toThrow("16 MiB");
    const other = new ArtifactStore("session_two");
    for (let index = 0; index < ARTIFACT_LIMITS.maxArtifacts; index++) other.write({ ...input, content: "" });
    expect(() => other.write(input)).toThrow("100 artifacts");
    const first = other.list()[0]!;
    expect(other.write({ ...input, id: first.id, expectedRevision: first.revision }).revision).toBe(2);
  });

  it("refuses symlink directories and records without touching their targets", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-artifacts-outside-"));
    fs.symlinkSync(outside, path.join(home, "artifacts"));
    expect(() => new ArtifactStore("session_one").write(input)).toThrow("symlink");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a symlinked session directory or artifact file and corrupted metadata", () => {
    const store = new ArtifactStore("session_one");
    const artifact = store.write(input);
    const file = path.join(home, "artifacts", "session_one", artifact.id + ".json");
    const outside = path.join(home, "outside.json");
    fs.renameSync(file, outside);
    fs.symlinkSync(outside, file);
    expect(() => store.read(artifact.id)).toThrow();
    expect(() => store.write({ ...input, id: artifact.id, expectedRevision: 1 })).toThrow();
    expect(JSON.parse(fs.readFileSync(outside, "utf8")).content).toBe(input.content);
    fs.symlinkSync(path.join(home, "artifacts", "session_one"), path.join(home, "artifacts", "session_alias"));
    expect(() => new ArtifactStore("session_alias").list()).toThrow("symlink");

    const broken = new ArtifactStore("session_broken").write(input);
    fs.writeFileSync(path.join(home, "artifacts", "session_broken", broken.id + ".json"), JSON.stringify({ ...broken, revision: -1 }));
    expect(() => new ArtifactStore("session_broken").read(broken.id)).toThrow("expectedRevision");
  });

  it("cancels without writing and fails closed when another writer owns the lock", () => {
    const store = new ArtifactStore("session_one");
    expect(() => store.write(input, AbortSignal.abort())).toThrow();
    expect(store.list()).toEqual([]);
    fs.mkdirSync(path.join(home, "artifacts", "session_one", ".write-lock"));
    expect(() => store.write(input)).toThrow("busy");
    expect(store.list()).toEqual([]);
  });

  it("releases its lock after an invalid update and rejects oversized disk records", () => {
    const store = new ArtifactStore("session_one");
    const artifact = store.write(input);
    expect(() => store.write({ ...input, id: artifact.id, expectedRevision: 2 })).toThrow("Artifact changed");
    expect(store.write({ ...input, id: artifact.id, expectedRevision: 1 }).revision).toBe(2);
    const file = path.join(home, "artifacts", "session_one", artifact.id + ".json");
    fs.truncateSync(file, ARTIFACT_LIMITS.maxContentBytes * 6 + 4097);
    expect(() => store.read(artifact.id)).toThrow("record size");
  });
});
