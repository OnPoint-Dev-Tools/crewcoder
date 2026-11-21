import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handoffEnv, parseCrewHandoff, readCrewHandoff, tmuxAttachHint, tmuxLaunchArgs, tmuxName, writeCrewHandoff, type CrewHandoff
} from "../tmux.js";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tmux-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const handoff: CrewHandoff = {
  version: 1,
  target: { kind: "workers", workers: ["planner", "builder"] },
  task: "ship it",
  command: "/crew planner,builder ship it",
  cwd: "/work",
  provider: "claude",
  model: "opus",
  effort: "high",
  mode: "general",
  fullAccess: false,
  env: { CREWCODER_HOME: "/h", PATH: "/bin" }
};

describe("tmux launch", () => {
  it("opens a background window inside tmux and a detached session outside, running the command without a shell", () => {
    const command = ["/usr/bin/node", "/app/cli.js", "--crew-file", "/tmp/x.json"];
    expect(tmuxLaunchArgs(command, "/work", "crew-a-1f2e", true)).toEqual(["new-window", "-d", "-n", "crew-a-1f2e", "-c", "/work", "--", ...command]);
    expect(tmuxLaunchArgs(command, "/work", "crew-a-1f2e", false)).toEqual(["new-session", "-d", "-s", "crew-a-1f2e", "-c", "/work", "--", ...command]);
  });

  it("makes tmux-safe names and tells the user how to reach the crew", () => {
    expect(tmuxName("planner + builder", "ab12")).toBe("crew-planner-builder-ab12");
    expect(tmuxName("team feature.v2:x", "ab12")).toBe("crew-team-feature-v2-x-ab12");
    expect(tmuxName("::", "ab12")).toBe("crew-crew-ab12");
    expect(tmuxAttachHint({ kind: "session", name: "crew-x" })).toContain("tmux attach -t crew-x");
    expect(tmuxAttachHint({ kind: "window", name: "crew-x" })).toContain("window crew-x");
  });

  it("forwards only CREWCODER_* variables and PATH", () => {
    expect(handoffEnv({ CREWCODER_HOME: "/h", CREWCODER_BIN: "/b", PATH: "/bin", HOME: "/home/me", SECRET_TOKEN: "x" }))
      .toEqual({ CREWCODER_HOME: "/h", CREWCODER_BIN: "/b", PATH: "/bin" });
  });
});

describe("crew handoff file", () => {
  it("round-trips through an owner-only file that is deleted once read", () => {
    const file = writeCrewHandoff(handoff, tempDir());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readCrewHandoff(file)).toEqual({ ...handoff, systemPrompt: undefined });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses a file other users can read, and deletes nothing it refused", () => {
    const file = path.join(tempDir(), "crewcoder-crew-open.json");
    fs.writeFileSync(file, JSON.stringify(handoff), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(() => readCrewHandoff(file)).toThrow(/readable by other users/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("validates every field the crew uses", () => {
    expect(() => parseCrewHandoff({ ...handoff, version: 2 })).toThrow(/Unsupported/);
    expect(() => parseCrewHandoff({ ...handoff, target: { kind: "workers", workers: ["-x"] } })).toThrow(/invalid worker or team/);
    expect(() => parseCrewHandoff({ ...handoff, target: { kind: "team", team: "--help" } })).toThrow(/invalid worker or team/);
    expect(() => parseCrewHandoff({ ...handoff, task: "" })).toThrow(/no task/);
    // Only CREWCODER_* and PATH are applied to the new UI's environment.
    expect(parseCrewHandoff({ ...handoff, env: { CREWCODER_HOME: "/h", LD_PRELOAD: "/evil.so", NODE_OPTIONS: "--require x" } }).env)
      .toEqual({ CREWCODER_HOME: "/h" });
    expect(parseCrewHandoff({ ...handoff, fullAccess: "yes" }).fullAccess).toBe(false);
  });
});
