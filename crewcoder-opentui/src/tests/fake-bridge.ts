import type { CrewCoderCrewOptions, CrewCoderEventHandler, CrewCoderProcessOptions, CrewCoderResumeOptions } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import type { CrewCoderJsonEvent } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/event-parser";
import type { SessionBridge } from "../session-controller.js";

/** Records bridge calls and lets tests push agent events into the active run. */
export class FakeBridge implements SessionBridge {
  running = false;
  runs: CrewCoderProcessOptions[] = [];
  resumes: CrewCoderResumeOptions[] = [];
  crews: CrewCoderCrewOptions[] = [];
  /** A crew process outlives each worker's agent_end, like the real child process. */
  private crewRun = false;
  followUps: string[] = [];
  approvals: Array<{ id: string; approved: boolean }> = [];
  previewRequests = 0;
  previewResolutions: Array<{ previewId: string; approved: boolean; summary?: string }> = [];
  uiResponses: Array<{ requestId: string; value: string | boolean | null }> = [];
  stops = 0;
  private handler: CrewCoderEventHandler | undefined;

  run(options: CrewCoderProcessOptions, onEvent: CrewCoderEventHandler): () => void {
    this.runs.push(options);
    this.crewRun = false;
    return this.attach(onEvent);
  }

  resume(options: CrewCoderResumeOptions, onEvent: CrewCoderEventHandler): () => void {
    this.resumes.push(options);
    this.crewRun = false;
    return this.attach(onEvent);
  }

  crew(options: CrewCoderCrewOptions, onEvent: CrewCoderEventHandler): () => void {
    this.crews.push(options);
    this.crewRun = true;
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

  resolveUiRequest(requestId: string, value: string | boolean | null): boolean {
    this.uiResponses.push({ requestId, value });
    return this.running;
  }

  stop(): void {
    this.stops += 1;
    this.running = false;
  }

  emit(event: CrewCoderJsonEvent): void {
    if (!this.handler) throw new Error("No active run to emit into.");
    this.handler(event);
    const ended = event.type === "process_exit" || (this.crewRun ? event.type === "crew_end" : event.type === "agent_end");
    if (ended) this.running = false;
  }

  private attach(onEvent: CrewCoderEventHandler): () => void {
    this.running = true;
    this.handler = onEvent;
    return () => this.stop();
  }
}
