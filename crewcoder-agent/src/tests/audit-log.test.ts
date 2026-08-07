import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditLog, getAuditLogPath, readAuditLog } from "../core/audit-log.js";

const originalCrewCoderHome = process.env.CREWCODER_HOME;

afterEach(() => {
  if (originalCrewCoderHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalCrewCoderHome;
});

describe("audit log", () => {
  it("appends redacted JSONL entries and filters by --since time", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-audit-home-"));
    process.env.CREWCODER_HOME = home;

    await appendAuditLog({ type: "tool_call", timestamp: "2026-01-01T00:00:00.000Z", sessionId: "s1", toolCallId: "t1", toolName: "write", args: { path: ".env", content: "API_TOKEN=secret" } });
    await appendAuditLog({ type: "write", timestamp: "2026-01-01T00:01:00.000Z", sessionId: "s1", toolName: "write", path: ".env" });

    expect(getAuditLogPath()).toBe(path.join(home, "logs", "audit.jsonl"));
    const all = await readAuditLog();
    expect(all).toHaveLength(2);
    expect(all[0].args).toMatchObject({ path: ".env", content: "[REDACTED]" });

    const recent = await readAuditLog({ since: new Date("2026-01-01T00:00:30.000Z") });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ type: "write", path: ".env" });
  });
});
