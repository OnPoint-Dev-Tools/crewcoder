import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDefaultWorker } from "../core/identity.js";

const originalCrewCoderHome = process.env.CREWCODER_HOME;

afterEach(() => {
  if (originalCrewCoderHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalCrewCoderHome;
});

describe("default worker identity", () => {
  it("creates Crew with starter owner metadata and useful instructions", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-identity-"));
    process.env.CREWCODER_HOME = home;

    const worker = ensureDefaultWorker();

    expect(worker.identity).toMatchObject({
      workerName: "Crew",
      ownerName: "CrewCoder User",
      ownerHandle: "@CrewCoderUser"
    });
    expect(worker.instructions).toContain("practical general-purpose coding partner");
    expect(worker.instructions).toContain("Inspect the real implementation");
    expect(worker.instructions).toContain("Verify relevant behavior");
    const instructionsPath = path.join(home, "workers", "Crew", "IDENTITY.md");
    expect(fs.readFileSync(instructionsPath, "utf8")).toBe(worker.instructions);

    fs.writeFileSync(instructionsPath, "# My customized Crew\n", "utf8");
    expect(ensureDefaultWorker().instructions).toBe("# My customized Crew\n");
  });

  it("preserves owner metadata when migrating a legacy identity", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-identity-legacy-"));
    process.env.CREWCODER_HOME = home;
    fs.writeFileSync(path.join(home, "identity.json"), JSON.stringify({
      ownerName: "Existing User",
      ownerHandle: "@ExistingUser"
    }), "utf8");

    const worker = ensureDefaultWorker();

    expect(worker.identity).toMatchObject({
      ownerName: "Existing User",
      ownerHandle: "@ExistingUser"
    });
  });
});
