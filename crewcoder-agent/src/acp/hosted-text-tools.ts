import { resolve } from "node:path";
import type { TextFileHost, ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";

/** Hosted calls never fall back to disk, decode images, or launch native tools. */
export function hostedTextTools(host: TextFileHost | undefined): ToolDefinition[] {
  if (!host?.readTextFile || !host.writeTextFile) throw new Error("Hosted text policy requires both ACP filesystem capabilities");
  return [
    {
      name: "read",
      description: "Read a virtual text record through the client host. Ordinary files are unavailable.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      executionMode: "sequential",
      parse(args) { if (typeof args.path !== "string") throw new Error("path is required"); return { path: args.path }; },
      async execute(args, context) {
        const content = await host.readTextFile!(resolve(context.cwd, String(args.path)));
        return textResult(content.slice(0, 50_000));
      }
    },
    {
      name: "write",
      description: "Submit virtual command or artifact source text through the client host. Ordinary files are unavailable.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      executionMode: "sequential",
      // The host authorizes each virtual operation, including its own confirmation wait.
      isMutation: false,
      parse(args) {
        if (typeof args.path !== "string" || typeof args.content !== "string") throw new Error("path and content are required");
        return { path: args.path, content: args.content };
      },
      async execute(args, context) {
        await host.writeTextFile!(resolve(context.cwd, String(args.path)), String(args.content));
        return textResult("Host accepted the virtual write. Read the corresponding result before claiming success.");
      }
    }
  ];
}
