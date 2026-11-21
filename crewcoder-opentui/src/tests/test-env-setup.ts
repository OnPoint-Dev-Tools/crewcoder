import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test file runs against a private CrewCoder home and none of the operator's
// CREWCODER_* settings, as in the agent's `test-home-setup.ts`. Without this, a shell
// with CREWCODER_PROVIDER=claude made tests pass locally that fail on CI (which gets the
// real default provider), and a test could read or write the real ~/.crewcoder.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CREWCODER_")) delete process.env[key];
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-opentui-vitest-"));
process.env.CREWCODER_HOME = path.join(testRoot, ".crewcoder");
