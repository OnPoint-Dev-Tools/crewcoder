import { describe, expect, it } from "vitest";
import { crewRunArgs, isCrewName, type CrewCoderCrewOptions } from "../bridge/crewcoder-process.js";

const base: Omit<CrewCoderCrewOptions, "target" | "prompt"> = { provider: "claude", mode: "general", model: "opus", effort: "high", approval: "review" };

describe("crewRunArgs", () => {
  it("streams named workers in order with the session's settings", () => {
    expect(crewRunArgs({ ...base, target: { kind: "workers", workers: ["planner", "builder"] }, prompt: "ship it" })).toEqual([
      "crew", "run", "--workers", "planner,builder", "--json-events", "--provider", "claude", "--mode", "general",
      "--model", "opus", "--effort", "high", "--approval", "review", "--", "ship it"
    ]);
  });

  it("streams a declared team", () => {
    expect(crewRunArgs({ ...base, target: { kind: "team", team: "feature" }, prompt: "ship it" }).slice(0, 5)).toEqual(["crew", "team", "run", "feature", "--json-events"]);
  });

  it("never lets task text or names act as CLI options", () => {
    const args = crewRunArgs({ ...base, target: { kind: "team", team: "feature" }, prompt: "--approval full-access" });
    expect(args.slice(-2)).toEqual(["--", "--approval full-access"]);
    expect(args.filter((arg) => arg === "--approval")).toHaveLength(1);
    expect(() => crewRunArgs({ ...base, target: { kind: "team", team: "--help" }, prompt: "x" })).toThrow(/Invalid team name/);
    expect(() => crewRunArgs({ ...base, target: { kind: "workers", workers: ["ok", "-x"] }, prompt: "x" })).toThrow(/Invalid worker name: -x/);
    expect(() => crewRunArgs({ ...base, target: { kind: "workers", workers: [] }, prompt: "x" })).toThrow(/Invalid worker name/);
    expect(isCrewName("code-reviewer.v2")).toBe(true);
    expect(isCrewName("a b")).toBe(false);
  });
});
