import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { editSymbolTool } from "../tools/edit-symbol.js";
import { LspClient, lspServerForFile } from "../tools/lsp-client.js";
import { createToolRegistry } from "../tools/index.js";

function context(cwd: string) { return { cwd, mode: "general" as const, sessionId: "test", mutationLog: [] as string[] }; }

describe("code intelligence tools", () => {
  it("registers LSP and symbol edit tools", () => {
    const names = createToolRegistry().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["lsp_definition", "lsp_hover", "lsp_diagnostics", "edit_symbol"]));
    expect(lspServerForFile("main.py").command).toBe("pyright-langserver");
    expect(lspServerForFile("main.go").command).toBe("gopls");
  });

  it("rewrites one qualified method body without reprinting the file", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-symbol-"));
    const file = path.join(cwd, "sample.ts");
    fs.writeFileSync(file, "// keep this spacing\nclass One {\n  run(value: number) {\n    return value + 1;\n  }\n}\nclass Two {\n  run() { return 2; }\n}\n", "utf8");
    const ctx = context(cwd);
    await editSymbolTool.execute({ path: "sample.ts", symbol: "One.run", body: "return value * 2;" }, ctx);
    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("// keep this spacing\nclass One");
    expect(result).toContain("run(value: number) {\n    return value * 2;\n  }");
    expect(result).toContain("run() { return 2; }");
    expect(ctx.mutationLog).toEqual(["sample.ts"]);
  });

  it("rejects ambiguous and syntactically invalid symbol edits", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-symbol-invalid-"));
    fs.writeFileSync(path.join(cwd, "sample.ts"), "class A { run() {} }\nclass B { run() {} }\n", "utf8");
    await expect(editSymbolTool.execute({ path: "sample.ts", symbol: "run", body: "return 1;" }, context(cwd))).rejects.toThrow(/ambiguous/i);
    await expect(editSymbolTool.execute({ path: "sample.ts", symbol: "A.run", body: "return (;" }, context(cwd))).rejects.toThrow(/invalid syntax/i);
  });

  it("speaks framed JSON-RPC to an LSP process", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-lsp-"));
    const server = path.join(cwd, "server.mjs");
    fs.writeFileSync(server, `let buffer=Buffer.alloc(0);process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const header=buffer.subarray(0,end).toString();const length=Number(/Content-Length:\\s*(\\d+)/i.exec(header)?.[1]);if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);if(typeof message.id==='number'){const result=message.method==='textDocument/hover'?{contents:'hover result'}:null;const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));process.stdout.write('Content-Length: '+body.length+'\\r\\n\\r\\n');process.stdout.write(body);}}});`, "utf8");
    fs.writeFileSync(path.join(cwd, "sample.ts"), "const value = 1;\n", "utf8");
    const client = new LspClient(cwd, { command: process.execPath, args: [server], languageId: "typescript" }, 2_000);
    try {
      const uri = await client.open(path.join(cwd, "sample.ts"));
      const hover = await client.request("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 1 } });
      expect(hover).toEqual({ contents: "hover result" });
    } finally {
      await client.dispose();
    }
  });
});
