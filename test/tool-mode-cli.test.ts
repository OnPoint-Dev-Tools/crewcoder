import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
it("exposes Tool mode through the real CLI config command", () => {
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [
    "--import", "tsx", "crewcoder-agent/src/cli.ts", "config", ...args
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, windowsHide: true }));
  expect(run("set", "toolMode", "native").toolMode).toBe("native");
  expect(run("show").toolMode).toBe("native");
  expect(run("set", "toolMode", "crewcoder").toolMode).toBe("crewcoder");
}, 30_000);

it("switches the persisted config through the tool-mode command and rejects invalid modes", () => {
  fs.mkdirSync(process.env.CREWCODER_HOME!, { recursive: true });
  const home = fs.mkdtempSync(path.join(process.env.CREWCODER_HOME!, "cli-tool-mode-"));
  const invoke = (...args: string[]) => spawnSync(process.execPath, [
    "--import", "tsx", "crewcoder-agent/src/cli.ts", "tool-mode", ...args
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, windowsHide: true, env: { ...process.env, CREWCODER_HOME: home } });
  const configPath = path.join(home, "config.json");
  const initial = invoke("--json");
  expect(initial.status).toBe(0);
  expect(JSON.parse(initial.stdout)).toEqual({ toolMode: "native", configPath });
  expect(JSON.parse(fs.readFileSync(configPath, "utf8")).toolMode).toBe("native");

  const changed = invoke("crewcoder");
  expect(changed.status).toBe(0);
  expect(changed.stdout).toContain("Tool mode for new sessions: crewcoder");
  expect(changed.stdout).toContain("Existing sessions keep their saved preference");
  expect(JSON.parse(fs.readFileSync(configPath, "utf8")).toolMode).toBe("crewcoder");
  expect(JSON.parse(invoke("status", "--json").stdout).toolMode).toBe("crewcoder");

  const invalid = invoke("both");
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain("toolMode must be one of: crewcoder, native");
  expect(JSON.parse(fs.readFileSync(configPath, "utf8")).toolMode).toBe("crewcoder");

  expect(JSON.parse(invoke("native", "--json").stdout)).toEqual({ toolMode: "native", configPath });
  expect(JSON.parse(fs.readFileSync(configPath, "utf8")).toolMode).toBe("native");
}, 30_000);
