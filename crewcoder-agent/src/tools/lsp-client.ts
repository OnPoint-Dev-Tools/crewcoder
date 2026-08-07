import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type LspPosition = { line: number; character: number };
export type LspServerSpec = { command: string; args: string[]; languageId: string };
type JsonRpcMessage = { id?: number; method?: string; result?: unknown; error?: { message?: string }; params?: unknown };
type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

const serverSpecs: Record<string, LspServerSpec> = {
  ".ts": { command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
  ".tsx": { command: "typescript-language-server", args: ["--stdio"], languageId: "typescriptreact" },
  ".js": { command: "typescript-language-server", args: ["--stdio"], languageId: "javascript" },
  ".jsx": { command: "typescript-language-server", args: ["--stdio"], languageId: "javascriptreact" },
  ".py": { command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  ".go": { command: "gopls", args: [], languageId: "go" }
};

export function lspServerForFile(file: string): LspServerSpec {
  const spec = serverSpecs[path.extname(file).toLowerCase()];
  if (!spec) throw new Error(`No LSP server configured for ${path.extname(file) || "this file type"}`);
  return spec;
}

export class LspClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private initialized = false;
  private readonly notifications: JsonRpcMessage[] = [];

  constructor(private readonly cwd: string, private readonly spec: LspServerSpec, private readonly timeoutMs = 10_000) {}

  async start(): Promise<void> {
    if (this.initialized) return;
    const child = spawn(this.spec.command, this.spec.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.on("error", (error) => this.failAll(new Error(`Could not start ${this.spec.command}: ${error.message}`)));
    child.on("close", (code) => this.failAll(new Error(`${this.spec.command} exited with code ${String(code)}`)));
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.cwd).href,
      capabilities: { textDocument: { hover: {}, definition: {}, publishDiagnostics: {} } },
      workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: path.basename(this.cwd) }]
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  async open(file: string): Promise<string> {
    await this.start();
    const text = await fs.readFile(file, "utf8");
    this.notify("textDocument/didOpen", { textDocument: { uri: pathToFileURL(file).href, languageId: this.spec.languageId, version: 1, text } });
    return pathToFileURL(file).href;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }

  async diagnostics(uri: string, waitMs = 500): Promise<unknown[]> {
    const existing = this.notifications.find((message) => message.method === "textDocument/publishDiagnostics" && isDiagnosticParams(message.params, uri));
    if (existing && isDiagnosticParams(existing.params, uri)) return existing.params.diagnostics;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    for (let index = this.notifications.length - 1; index >= 0; index--) {
      const published = this.notifications[index];
      if (published?.method === "textDocument/publishDiagnostics" && isDiagnosticParams(published.params, uri)) return published.params.diagnostics;
    }
    return [];
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    if (this.initialized) {
      try { await this.request("shutdown", null); } catch { /* process may already be gone */ }
      this.notify("exit", null);
    }
    this.child.kill("SIGTERM");
    this.child = undefined;
    this.initialized = false;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child) throw new Error("LSP server is not running");
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.handle(JSON.parse(body) as JsonRpcMessage);
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (typeof message.id !== "number") { this.notifications.push(message); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "LSP request failed"));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

function isDiagnosticParams(value: unknown, uri: string): value is { uri: string; diagnostics: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const params = value as { uri?: unknown; diagnostics?: unknown };
  return params.uri === uri && Array.isArray(params.diagnostics);
}
