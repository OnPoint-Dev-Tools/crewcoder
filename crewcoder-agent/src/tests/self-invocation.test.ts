import { describe, expect, it } from "vitest";
import { createSelfInvocation } from "../core/self-invocation.js";

const versions = process.versions;

describe("CrewCoder self invocation", () => {
  it("restarts a Node CLI through its script entry", () => {
    expect(createSelfInvocation(["goal", "worker", "g1"], {
      argv: ["/usr/bin/node", "/opt/crewcoder/dist/cli.js"],
      execArgv: ["--enable-source-maps"],
      execPath: "/usr/bin/node",
      versions: { ...versions, bun: undefined }
    })).toEqual({
      command: "/usr/bin/node",
      args: ["--enable-source-maps", "/opt/crewcoder/dist/cli.js", "goal", "worker", "g1"]
    });
  });

  it("restarts a Bun-compiled CLI through the standalone executable", () => {
    expect(createSelfInvocation(["goal", "worker", "g1"], {
      argv: ["bun", "/$bunfs/root/crewcoder-linux-x64", "goal", "start"],
      execArgv: [],
      execPath: "/opt/crewcoder/crewcoder",
      versions: { ...versions, bun: "1.3.13" }
    })).toEqual({
      command: "/opt/crewcoder/crewcoder",
      args: ["goal", "worker", "g1"]
    });
  });

  it("restarts a native executable when argv points at execPath", () => {
    expect(createSelfInvocation(["serve"], {
      argv: ["/opt/crewcoder/crewcoder"],
      execArgv: [],
      execPath: "/opt/crewcoder/crewcoder",
      versions
    })).toEqual({ command: "/opt/crewcoder/crewcoder", args: ["serve"] });
  });
});
