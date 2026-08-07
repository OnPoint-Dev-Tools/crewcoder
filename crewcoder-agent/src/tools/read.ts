import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { describeToolImage, describeToolImageForModel } from "../core/tool-images.js";
import { resolveInsideCwd } from "./path-utils.js";
import { readTextFile } from "./text-file-io.js";
import { DEFAULT_TOOL_OUTPUT_BYTES, DEFAULT_TOOL_OUTPUT_LINES, truncateToolOutputHead } from "./tool-output-limits.js";

type Args = { path: string; maxBytes: number; offset: number; limit?: number };

export const readTool: ToolDefinition<Args> = {
  name: "read",
  description: "Read a workspace file. Image files are described and displayed inline rather than returned as bytes. Text output is capped at 2,000 lines or 50KB; use offset/limit to continue through large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path, or an absolute path inside a session external directory." },
      offset: { type: "integer", description: "Line number to start reading from (1-indexed).", minimum: 1 },
      limit: { type: "integer", description: "Maximum number of lines to read.", minimum: 1, maximum: DEFAULT_TOOL_OUTPUT_LINES },
      maxBytes: { type: "integer", description: "Maximum UTF-8 bytes to return before truncating (maximum 50KB).", minimum: 1, maximum: DEFAULT_TOOL_OUTPUT_BYTES }
    },
    required: ["path"],
    additionalProperties: false
  },
  executionMode: "parallel",
  parse(args) {
    const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : DEFAULT_TOOL_OUTPUT_BYTES;
    return {
      path: String(args.path ?? ""),
      maxBytes: Math.min(Math.max(maxBytes, 1), DEFAULT_TOOL_OUTPUT_BYTES),
      offset: typeof args.offset === "number" ? Math.max(1, Math.floor(args.offset)) : 1,
      limit: typeof args.limit === "number" ? Math.min(Math.max(1, Math.floor(args.limit)), DEFAULT_TOOL_OUTPUT_LINES) : undefined
    };
  },
  async execute(args, context) {
    const file = resolveInsideCwd(context.cwd, args.path, context.externalDirectories);

    // Images are checked first: decoding a PNG as UTF-8 fills the context with
    // garbage the model cannot use and costs real tokens. Declaring it on
    // `details.images` is what lets the TUI blit the actual picture.
    const image = await describeToolImage(file, context.cwd);
    if (image) {
      return textResult(describeToolImageForModel(image), { path: args.path, bytes: image.byteSize, truncated: false, images: [image] });
    }

    const content = await readTextFile(context, file);
    const bytes = Buffer.byteLength(content, "utf8");
    const allLines = content.split("\n");
    const startIndex = args.offset - 1;
    if (startIndex >= allLines.length) throw new Error(`Offset ${args.offset} is beyond end of file (${allLines.length} lines total)`);
    const selected = allLines.slice(startIndex, args.limit === undefined ? undefined : startIndex + args.limit).join("\n");
    const truncation = truncateToolOutputHead(selected, { maxBytes: args.maxBytes, maxLines: args.limit ?? DEFAULT_TOOL_OUTPUT_LINES });
    const endLine = startIndex + truncation.outputLines;
    const hasMoreLines = endLine < allLines.length;
    const firstLineExceedsLimit = Buffer.byteLength(allLines[startIndex] ?? "", "utf8") > args.maxBytes;
    const notices: string[] = [];
    if (firstLineExceedsLimit) {
      notices.push(`Line ${args.offset} exceeds the ${Math.round(args.maxBytes / 1024)}KB limit and was truncated; use a narrower bash command to inspect that line`);
    } else if (truncation.truncated) {
      notices.push(`Showing lines ${args.offset}-${Math.max(args.offset, endLine)} of ${allLines.length} (${Math.round(args.maxBytes / 1024)}KB/2,000-line limit)`);
    } else if (args.limit !== undefined && hasMoreLines) {
      notices.push(`${allLines.length - endLine} more lines in file`);
    }
    if (notices.length && hasMoreLines && !firstLineExceedsLimit) notices.push(`Use offset=${endLine + 1} to continue`);
    const text = notices.length ? `${truncation.text}\n\n[${notices.join(". ")}.]` : truncation.text;
    return textResult(text, {
      path: args.path,
      bytes,
      totalLines: allLines.length,
      offset: args.offset,
      outputLines: truncation.outputLines,
      truncated: truncation.truncated || (args.limit !== undefined && hasMoreLines),
      truncatedBy: truncation.truncatedBy
    });
  }
};
