import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, setConfigValue } from "../core/config.js";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-thinking-settings-"));
  previousHome = process.env.CREWCODER_HOME;
  process.env.CREWCODER_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("thinking settings", () => {
  it("defaults on and persists explicit off/on values", () => {
    expect(readConfig().thinkingEnabled).toBe(true);
    expect(setConfigValue("thinkingEnabled", "false").thinkingEnabled).toBe(false);
    expect(readConfig().thinkingEnabled).toBe(false);
    expect(setConfigValue("thinkingEnabled", "true").thinkingEnabled).toBe(true);
  });

  it("rejects ambiguous boolean values", () => {
    expect(() => setConfigValue("thinkingEnabled", "on")).toThrow(/true or false/);
  });
});
