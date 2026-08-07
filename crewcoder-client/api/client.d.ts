export type CrewCoderAgentMode = "general" | "plugin" | "extension";
export type CrewCoderApprovalMode = "never" | "review" | "always" | "full-access" | "sandboxed";
/** Browser-safe structural event type. Narrow by `type` and validate fields used by your UI. */
export type CrewCoderRemoteAgentEvent = {
    type: string;
    [key: string]: unknown;
};
export declare const CREWCODER_FLEET_PROTOCOL_VERSION: "1.0";
export type CrewCoderFleetRunRequest = {
    prompt?: string;
    sessionId?: string;
    mode?: CrewCoderAgentMode;
    provider?: string;
    model?: string;
    worker?: string;
    systemPrompt?: string;
    effort?: string;
    cwd?: string;
    approval?: CrewCoderApprovalMode;
    maxIterations?: number;
    heuristic?: boolean;
};
export type CrewCoderFleetRunStatus = "running" | "completed" | "failed" | "aborted";
export type CrewCoderFleetRunSummary = {
    runId: string;
    status: CrewCoderFleetRunStatus;
    sessionId?: string;
    error?: string;
    eventCount: number;
    lastEventId: number;
    createdAt: string;
    updatedAt: string;
};
export type CrewCoderFleetRunCreated = {
    runId: string;
    status: CrewCoderFleetRunStatus;
    eventUrl: string;
    wsUrl: string;
};
export type CrewCoderFleetProtocolEvent = {
    type: "fleet_run_created";
    runId: string;
    status: CrewCoderFleetRunStatus;
} | {
    type: "fleet_run_status";
    runId: string;
    status: CrewCoderFleetRunStatus;
    sessionId?: string;
    error?: string;
    interrupted?: boolean;
};
export type CrewCoderFleetEvent = (CrewCoderRemoteAgentEvent | CrewCoderFleetProtocolEvent) & {
    fleetEventId?: number;
    emittedAt?: string;
};
export type CrewCoderFleetControl = {
    type: "control";
    action: "compact";
} | {
    type: "control";
    action: "follow_up";
    message: string;
} | {
    type: "control";
    action: "approval";
    approvalId: string;
    approved: boolean;
    reason?: string;
} | {
    type: "control";
    action: "ui_response";
    requestId: string;
    value: string | boolean | null;
} | {
    type: "control";
    action: "abort";
};
export type CrewCoderFleetHealth = {
    ok: boolean;
    service: string;
    authentication: string;
    protocolVersion: string;
    durability: "persistent" | "memory";
};
export type CrewCoderFleetReconnectOptions = {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
};
export type CrewCoderFleetClientOptions = {
    baseUrl: string;
    token: string;
    fetch?: typeof globalThis.fetch;
    reconnect?: false | CrewCoderFleetReconnectOptions;
};
export type CrewCoderFleetEventStreamOptions = {
    replay?: boolean;
    signal?: AbortSignal;
    afterEventId?: number;
    reconnect?: false | CrewCoderFleetReconnectOptions;
    onReconnect?(attempt: number, afterEventId: number): Promise<void> | void;
};
export type CrewCoderFleetWaitOptions = {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    timeoutMs?: number;
};
export declare class CrewCoderClient {
    private readonly baseUrl;
    private readonly token;
    private readonly fetchImpl;
    private readonly reconnect;
    constructor(options: CrewCoderFleetClientOptions);
    health(): Promise<CrewCoderFleetHealth>;
    createRun(request: CrewCoderFleetRunRequest): Promise<CrewCoderFleetRunCreated>;
    listRuns(): Promise<CrewCoderFleetRunSummary[]>;
    getRun(runId: string): Promise<CrewCoderFleetRunSummary>;
    waitForRun(runId: string, options?: CrewCoderFleetWaitOptions): Promise<CrewCoderFleetRunSummary>;
    control(runId: string, control: CrewCoderFleetControl): Promise<boolean>;
    streamEvents(runId: string, listener: (event: CrewCoderFleetEvent) => Promise<void> | void, options?: CrewCoderFleetEventStreamOptions): Promise<void>;
    webSocketConnection(runId: string, afterEventId?: number): {
        url: string;
        protocols: string[];
    };
    private consumeEventStream;
    private authenticatedJson;
    private authHeaders;
}
/** Backward-compatible name retained for users migrating from crewcoder-sdk. */
export { CrewCoderClient as CrewCoderFleetClient };
//# sourceMappingURL=client.d.ts.map