import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../core/events.js";
import { backgroundJobTool, clearBackgroundJobsForTests } from "../tools/background-job.js";

afterEach(() => clearBackgroundJobsForTests());

describe("background_job tool", () => {
  it("starts immediately, streams events, and reports completion", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-bg-"));
    const events: AgentEvent[] = [];
    const context = { cwd, mode: "general" as const, sessionId: "test", mutationLog: [], emit: (event: AgentEvent) => { events.push(event); } };
    const started = await backgroundJobTool.execute({ action: "start", command: "printf ready", bgId: undefined }, context);
    const bgId = String(started.details?.bgId);
    expect(bgId).toMatch(/^bg_/);
    expect(events[0]).toMatchObject({ type: "background_job_start", bgId });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await backgroundJobTool.execute({ action: "status", bgId, command: undefined }, context);
    expect(status.details).toMatchObject({ bgId, status: "completed", output: "ready", exitCode: 0 });
    expect(events.some((event) => event.type === "background_job_output")).toBe(true);
    expect(events.some((event) => event.type === "background_job_end")).toBe(true);
  });

  it("stops a running job", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-bg-"));
    const context = { cwd, mode: "general" as const, sessionId: "test", mutationLog: [] };
    const started = await backgroundJobTool.execute({ action: "start", command: "sleep 10", bgId: undefined }, context);
    const bgId = String(started.details?.bgId);
    const stopped = await backgroundJobTool.execute({ action: "stop", bgId, command: undefined }, context);
    expect(stopped.details).toMatchObject({ bgId, status: "stopped" });
  });
});
