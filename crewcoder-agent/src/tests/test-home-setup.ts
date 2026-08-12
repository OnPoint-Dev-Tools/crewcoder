import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Every test file gets a private CrewCoder home. Tests exercise real session,
// checkpoint, cost, extension, and config persistence; falling through to the
// operator's ~/.crewcoder makes a normal test run look like hundreds of real
// conversations and can mutate trusted state.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-vitest-"));
const testHome = path.join(testRoot, ".crewcoder");
process.env.CREWCODER_HOME = testHome;

// Exported only for a regression assertion. Runtime code continues to resolve
// the home through the same CREWCODER_HOME boundary used in production.
export const isolatedCrewCoderTestHome = testHome;

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
