import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFilesystemSkills, findFilesystemSkill, parseSkillFile, resolveSkillsDir } from "../skills/filesystem/loader.js";

let tmpDir: string;

function writeSkill(name: string, frontmatter: string, body: string): void {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcode-skills-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("filesystem skills loader", () => {
  it("returns an empty list when the skills directory is absent", () => {
    expect(loadFilesystemSkills(path.join(tmpDir, "missing"))).toEqual([]);
  });

  it("loads and parses skills sorted by name", () => {
    writeSkill("zeta", "name: zeta\ndescription: Last one", "Zeta body");
    writeSkill("alpha", "name: alpha\ndescription: First one", "Alpha body");
    const skills = loadFilesystemSkills(tmpDir);
    expect(skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(skills[0].description).toBe("First one");
    expect(skills[0].body).toBe("Alpha body");
  });

  it("falls back to the directory name when frontmatter omits name", () => {
    writeSkill("orphan", "description: No name field", "Body");
    const skills = loadFilesystemSkills(tmpDir);
    expect(skills[0].name).toBe("orphan");
  });

  it("skips directories without a SKILL.md", () => {
    fs.mkdirSync(path.join(tmpDir, "empty"), { recursive: true });
    writeSkill("real", "name: real\ndescription: Real skill", "Body");
    expect(loadFilesystemSkills(tmpDir).map((s) => s.name)).toEqual(["real"]);
  });

  it("finds a skill case-insensitively by name", () => {
    writeSkill("code-review", "name: code-review\ndescription: Reviews code", "Review body");
    expect(findFilesystemSkill("CODE-REVIEW", tmpDir)?.body).toBe("Review body");
    expect(findFilesystemSkill("nope", tmpDir)).toBeUndefined();
  });

  it("parses frontmatter with quoted values and ignores body markers", () => {
    const parsed = parseSkillFile('---\nname: "x"\ndescription: \'hi\'\n---\nbody', "fallback");
    expect(parsed).toEqual({ name: "x", description: "hi", body: "body" });
  });

  it("treats files without frontmatter as pure body", () => {
    const parsed = parseSkillFile("just a body", "fallback");
    expect(parsed).toEqual({ name: "fallback", description: "", body: "just a body" });
  });

  it("honors the CREWCODER_SKILLS_DIR override", () => {
    const prev = process.env.CREWCODER_SKILLS_DIR;
    process.env.CREWCODER_SKILLS_DIR = tmpDir;
    try {
      expect(resolveSkillsDir()).toBe(path.resolve(tmpDir));
    } finally {
      if (prev === undefined) delete process.env.CREWCODER_SKILLS_DIR;
      else process.env.CREWCODER_SKILLS_DIR = prev;
    }
  });

  it("defaults to the skills directory under the CrewCoder home (~/.crewcoder)", () => {
    const prevSkills = process.env.CREWCODER_SKILLS_DIR;
    const prevHome = process.env.CREWCODER_HOME;
    delete process.env.CREWCODER_SKILLS_DIR;
    process.env.CREWCODER_HOME = tmpDir;
    try {
      expect(resolveSkillsDir()).toBe(path.join(path.resolve(tmpDir), "skills"));
    } finally {
      if (prevSkills === undefined) delete process.env.CREWCODER_SKILLS_DIR;
      else process.env.CREWCODER_SKILLS_DIR = prevSkills;
      if (prevHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = prevHome;
    }
  });
});
