import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
it("exposes Tool mode through the real CLI config command", () => {
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [
    "--import", "tsx", "crewcoder-agent/src/cli.ts", "config", ...args
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, windowsHide: true }));
  expect(run("set", "toolMode", "native").toolMode).toBe("native");
  expect(run("show").toolMode).toBe("native");
  expect(run("set", "toolMode", "crewcoder").toolMode).toBe("crewcoder");
}, 30_000);
