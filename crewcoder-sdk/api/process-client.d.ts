import { type PromptResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
export type CrewCoderProcessOptions = {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    permission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
};
export type CrewCoderProcessPromptOptions = {
    sessionId?: string;
};
export type CrewCoderProcessEventListener = (event: SessionNotification) => Promise<void> | void;
export declare class CrewCoderProcess {
    private readonly child;
    private readonly connection;
    private readonly cwd;
    private readonly listeners;
    private activeSessionId;
    private running;
    private disposed;
    private constructor();
    static create(options?: CrewCoderProcessOptions): Promise<CrewCoderProcess>;
    get sessionId(): string | undefined;
    get isRunning(): boolean;
    subscribe(listener: CrewCoderProcessEventListener): () => void;
    prompt(prompt: string, options?: CrewCoderProcessPromptOptions): Promise<PromptResponse>;
    abort(): boolean;
    dispose(): void;
    private assertUsable;
}
export declare function createCrewCoderProcess(options?: CrewCoderProcessOptions): Promise<CrewCoderProcess>;
//# sourceMappingURL=process-client.d.ts.map