import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { truncateToolOutputTail } from "./tool-output-limits.js";

const MAX_CAPTURE_CHARS = 120_000;
const blocked = ["rm -rf /", "mkfs", "shutdown", "reboot", ":(){:|:&};:", "dd if="];
type JobStatus = "running" | "completed" | "failed" | "stopped";
type Job = { id: string; command: string; cwd: string; child: ChildProcess; status: JobStatus; output: string; exitCode?: number | null; startedAt: string; endedAt?: string };
type Args = { action: "start" | "status" | "stop"; command?: string; bgId?: string };

const jobs = new Map<string, Job>();

export const backgroundJobTool: ToolDefinition<Args> = {
  name: "background_job",
  description: "Start a long-running shell command without blocking, inspect its buffered output/status, or stop it by bg_id.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "status", "stop"], description: "Job operation." },
      command: { type: "string", description: "Shell command; required for start." },
      bgId: { type: "string", description: "Background job id; required for status or stop." }
    },
    required: ["action"],
    additionalProperties: false
  },
  executionMode: "sequential",
  parse(args) {
    const action = args.action === "status" || args.action === "stop" ? args.action : "start";
    return { action, command: typeof args.command === "string" ? args.command : undefined, bgId: typeof args.bgId === "string" ? args.bgId : undefined };
  },
  async execute(args, context) {
    if (args.action === "start") {
      if (!args.command) throw new Error("command is required to start a background job");
      if (blocked.some((token) => args.command?.includes(token))) throw new Error(`Blocked risky command: ${args.command}`);
      if (context.sandbox?.policy.enabled) throw new Error("Background jobs are unavailable in sandboxed approval modes until persistent sandbox lifecycle isolation is supported");
      const id = `bg_${randomUUID().slice(0, 12)}`;
      const child = spawn(args.command, { cwd: context.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      const job: Job = { id, command: args.command, cwd: context.cwd, child, status: "running", output: "", startedAt: new Date().toISOString() };
      jobs.set(id, job);
      const append = (chunk: Buffer) => {
        const text = chunk.toString();
        job.output = (job.output + text).slice(-MAX_CAPTURE_CHARS);
        void context.emit?.({ type: "background_job_output", bgId: id, text });
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (error) => append(Buffer.from(`\n${error.message}`)));
      child.on("close", (code, signal) => {
        job.exitCode = code;
        job.status = job.status === "stopped" ? "stopped" : code === 0 ? "completed" : "failed";
        job.endedAt = new Date().toISOString();
        void context.emit?.({ type: "background_job_end", bgId: id, status: job.status, exitCode: code, signal: signal ?? undefined, endedAt: job.endedAt });
      });
      await context.emit?.({ type: "background_job_start", bgId: id, command: args.command, cwd: context.cwd, startedAt: job.startedAt });
      return textResult(`Started background job ${id}`, snapshot(job));
    }

    if (!args.bgId) throw new Error(`bgId is required to ${args.action} a background job`);
    const job = jobs.get(args.bgId);
    if (!job) throw new Error(`Unknown background job: ${args.bgId}`);
    if (args.action === "stop" && job.status === "running") {
      job.status = "stopped";
      job.child.kill("SIGTERM");
      await context.emit?.({ type: "background_job_status", bgId: job.id, command: job.command, status: job.status, output: job.output.trim(), exitCode: job.exitCode, startedAt: job.startedAt, endedAt: job.endedAt });
    }
    const details = snapshot(job);
    const bounded = truncateToolOutputTail(job.output.trim());
    const output = bounded.text || "(no output)";
    const notice = bounded.truncated ? "\n\n[Background job output truncated: showing the last 2,000 lines or 50KB.]" : "";
    return textResult(`${job.id} ${job.status}\n${output}${notice}`, { ...details, output: bounded.text, truncated: bounded.truncated });
  }
};

function snapshot(job: Job): Record<string, unknown> {
  return { bgId: job.id, command: job.command, status: job.status, output: job.output.trim(), exitCode: job.exitCode, startedAt: job.startedAt, endedAt: job.endedAt };
}

export function clearBackgroundJobsForTests(): void {
  for (const job of jobs.values()) if (job.status === "running") job.child.kill("SIGTERM");
  jobs.clear();
}
