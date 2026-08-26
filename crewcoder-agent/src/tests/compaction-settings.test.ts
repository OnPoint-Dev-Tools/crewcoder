import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig, setConfigValue } from "../core/config.js";

const originalCrewCoderHome = process.env.CREWCODER_HOME;

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-compaction-config-"));
  process.env.CREWCODER_HOME = home;
  return home;
}

afterEach(() => {
  if (originalCrewCoderHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalCrewCoderHome;
});

describe("auto-compaction settings", () => {
  it("enables auto-compaction without writing a default absolute threshold", () => {
    const home = temporaryHome();

    const config = readConfig();
    const persisted = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as Record<string, unknown>;

    expect(config.autoCompact).toBe(true);
    expect(config.autoCompactThresholdTokens).toBeUndefined();
    expect(persisted.autoCompact).toBe(true);
    expect(persisted).not.toHaveProperty("autoCompactThresholdTokens");
  });

  it("keeps an explicitly configured unknown-model fallback", () => {
    temporaryHome();

    expect(setConfigValue("autoCompactThresholdTokens", "220000").autoCompactThresholdTokens).toBe(220_000);
    expect(readConfig().autoCompactThresholdTokens).toBe(220_000);
  });
});
