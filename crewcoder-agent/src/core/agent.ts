import type { AgentEvent, AgentEventSink } from "./events.js";
import type { AgentMessage } from "./messages.js";
import type { AgentMode } from "./types.js";
import { DEFAULT_AGENT_MODE } from "./mode-router.js";
import { runAgentLoop, type AgentLoopResult } from "./agent-loop.js";
import type { ModelClient } from "./model-client.js";
export type AgentOptions = { cwd?: string; externalDirectories?: string[]; mode?: AgentMode; modelClient?: ModelClient; maxIterations?: number };
export class Agent { private readonly listeners = new Set<AgentEventSink>(); private readonly messages: AgentMessage[] = []; constructor(private readonly options: AgentOptions = {}) {} subscribe(listener: AgentEventSink): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); } get transcript(): AgentMessage[] { return this.messages.slice(); } async prompt(prompt: string): Promise<AgentLoopResult> { const result = await runAgentLoop({ prompt, requestedMode: this.options.mode ?? DEFAULT_AGENT_MODE, cwd: this.options.cwd ?? process.cwd(), externalDirectories: this.options.externalDirectories }, { modelClient: this.options.modelClient, maxIterations: this.options.maxIterations, emit: async (event) => { await this.processEvent(event); } }); this.messages.push(...result.messages); return result; } private async processEvent(event: AgentEvent): Promise<void> { for (const listener of this.listeners) await listener(event); } }
