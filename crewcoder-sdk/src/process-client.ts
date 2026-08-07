import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from "@agentclientprotocol/sdk";

export type CrewCoderProcessOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  permission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
};

export type CrewCoderProcessPromptOptions = { sessionId?: string };
export type CrewCoderProcessEventListener = (event: SessionNotification) => Promise<void> | void;

export class CrewCoderProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: ClientSideConnection;
  private readonly cwd: string;
  private readonly listeners = new Set<CrewCoderProcessEventListener>();
  private activeSessionId: string | undefined;
  private running = false;
  private disposed = false;

  private constructor(child: ChildProcessWithoutNullStreams, connection: ClientSideConnection, cwd: string) {
    this.child = child;
    this.connection = connection;
    this.cwd = cwd;
  }

  static async create(options: CrewCoderProcessOptions = {}): Promise<CrewCoderProcess> {
    const cwd = options.cwd ?? process.cwd();
    const child = spawn(options.command ?? "crewcoder", options.args ?? ["acp"], {
      cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    let instance: CrewCoderProcess | undefined;
    const client: Client = {
      requestPermission(request) {
        if (options.permission) return options.permission(request);
        return { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate(event) {
        if (!instance) return;
        for (const listener of [...instance.listeners]) await listener(event);
      }
    };
    const connection = new ClientSideConnection(() => client, ndJsonStream(output, input));
    instance = new CrewCoderProcess(child, connection, cwd);
    try {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "crewcoder-sdk", version: "0.6.0" } });
      return instance;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  get sessionId(): string | undefined { return this.activeSessionId; }
  get isRunning(): boolean { return this.running; }

  subscribe(listener: CrewCoderProcessEventListener): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(prompt: string, options: CrewCoderProcessPromptOptions = {}): Promise<PromptResponse> {
    this.assertUsable();
    if (this.running) throw new Error("CrewCoderProcess is already running.");
    if (!prompt.trim()) throw new Error("CrewCoderProcess.prompt() requires a non-empty prompt.");
    this.running = true;
    try {
      if (options.sessionId && options.sessionId !== this.activeSessionId) {
        await this.connection.loadSession({ sessionId: options.sessionId, cwd: this.cwd, mcpServers: [] });
        this.activeSessionId = options.sessionId;
      }
      if (!this.activeSessionId) {
        const created = await this.connection.newSession({ cwd: this.cwd, mcpServers: [] });
        this.activeSessionId = created.sessionId;
      }
      return await this.connection.prompt({
        sessionId: this.activeSessionId,
        prompt: [{ type: "text", text: prompt.trim() }]
      });
    } finally {
      this.running = false;
    }
  }

  abort(): boolean {
    if (!this.running || !this.activeSessionId) return false;
    void this.connection.cancel({ sessionId: this.activeSessionId });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.abort();
    this.child.kill();
    this.listeners.clear();
    this.disposed = true;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("CrewCoderProcess has been disposed.");
  }
}

export function createCrewCoderProcess(options: CrewCoderProcessOptions = {}): Promise<CrewCoderProcess> {
  return CrewCoderProcess.create(options);
}
