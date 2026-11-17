import type { CrewCoderEventHandler, CrewCoderProcessOptions, CrewCoderResumeOptions } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import type { CrewCoderJsonEvent } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/event-parser";
import type { SessionBridge } from "../session-controller.js";

/** Records bridge calls and lets tests push agent events into the active run. */
export class FakeBridge implements SessionBridge {
  running = false;
  runs: CrewCoderProcessOptions[] = [];
  resumes: CrewCoderResumeOptions[] = [];
  followUps: string[] = [];
  approvals: Array<{ id: string; approved: boolean }> = [];
  previewRequests = 0;
  previewResolutions: Array<{ previewId: string; approved: boolean; summary?: string }> = [];
  stops = 0;
  private handler: CrewCoderEventHandler | undefined;

  run(options: CrewCoderProcessOptions, onEvent: CrewCoderEventHandler): () => void {
    this.runs.push(options);
    return this.attach(onEvent);
  }

  resume(options: CrewCoderResumeOptions, onEvent: CrewCoderEventHandler): () => void {
    this.resumes.push(options);
    return this.attach(onEvent);
  }

  followUp(message: string): boolean {
    this.followUps.push(message);
    return this.running;
  }

  resolveApproval(approvalId: string, approved: boolean): boolean {
    this.approvals.push({ id: approvalId, approved });
    return this.running;
  }

  requestCompactionPreview(): boolean {
    this.previewRequests += 1;
    return this.running;
  }

  resolveCompactionPreview(previewId: string, approved: boolean, summary?: string): boolean {
    this.previewResolutions.push({ previewId, approved, summary });
    return this.running;
  }

  stop(): void {
    this.stops += 1;
    this.running = false;
  }

  emit(event: CrewCoderJsonEvent): void {
    if (!this.handler) throw new Error("No active run to emit into.");
    this.handler(event);
    if (event.type === "agent_end" || event.type === "process_exit") this.running = false;
  }

  private attach(onEvent: CrewCoderEventHandler): () => void {
    this.running = true;
    this.handler = onEvent;
    return () => this.stop();
  }
}
