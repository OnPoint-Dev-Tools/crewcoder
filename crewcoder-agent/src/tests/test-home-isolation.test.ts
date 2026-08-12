import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCrewCoderHome } from "../core/crewcoder-home.js";
import { isolatedCrewCoderTestHome } from "./test-home-setup.js";

describe("Vitest CrewCoder home isolation", () => {
  it("never resolves persistence into the operator's real CrewCoder home", () => {
    const resolved = getCrewCoderHome();
    expect(resolved.source).toBe("env");
    expect(resolved.root).toBe(isolatedCrewCoderTestHome);
    expect(path.basename(resolved.root)).toBe(".crewcoder");
    expect(resolved.root.startsWith(`${os.tmpdir()}${path.sep}`)).toBe(true);
    expect(resolved.root).not.toBe(path.join(os.homedir(), ".crewcoder"));
    expect(resolved.root).not.toBe(path.resolve("/.crewcoder"));
  });
});
