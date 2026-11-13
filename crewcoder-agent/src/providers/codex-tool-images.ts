import fs from "node:fs/promises";
import { getText, type ToolResultMessage } from "../core/messages.js";
import { detectImageMime } from "../core/tool-images.js";
import { resolveReadablePath } from "../tools/path-utils.js";

type ContentItem = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string };
type CodexToolResult = { contentItems: ContentItem[]; success: boolean };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export const CODEX_IMAGE_READ_GUIDANCE = [
  'For image files in Codex code mode, emit pixels explicitly:',
  'const result = await tools.read({ path: "path/to/image.png" });',
  'for (const line of result.split("\\n")) { if (line.startsWith("data:image/")) image(line); }',
  'Printing the result with text(...) sends only text/data URLs, not visible pixels.',
  'Do not pass the entire mixed text/image result to image(...). If no data:image/ line is returned, stop and report image delivery unavailable.'
].join('\n');

/** Encode only at the provider boundary so session/event records keep paths, not screen bytes. */
export async function codexToolResult(result: ToolResultMessage, cwd: string, externalDirectories: readonly string[] = []): Promise<CodexToolResult> {
  const text: ContentItem = { type: "inputText", text: getText(result) };
  if (result.isError) return { contentItems: [text], success: false };
  const images = result.details?.images;
  if (images === undefined) return { contentItems: [text], success: true };
  try {
    if (!Array.isArray(images) || images.length > 4) throw new Error("Expected at most four image attachments");
    const contentItems: ContentItem[] = [text];
    let total = 0;
    const attachments: unknown[] = images;
    for (const image of attachments) {
      if (!image || typeof image !== "object" || !("path" in image) || typeof image.path !== "string") throw new Error("Invalid image attachment");
      // Metadata must not widen the read tool's existing workspace/external-directory access.
      const file = resolveReadablePath(cwd, image.path, externalDirectories);
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES || total + stat.size > MAX_TOTAL_BYTES) throw new Error("Image attachment exceeds its size limit");
        // A bounded read also covers files that grow after stat without allocating their new size.
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== stat.size) throw new Error("Image changed while it was being read");
        const bytes = buffer.subarray(0, length);
        const mime = detectImageMime(bytes);
        if (!mime || mime === "image/bmp") throw new Error("Image attachment must be PNG, JPEG, GIF or WebP");
        contentItems.push({ type: "inputImage", imageUrl: `data:${mime};base64,${bytes.toString("base64")}` });
        total += length;
      } finally { await handle.close(); }
    }
    if (attachments.length) {
      // Code mode converts dynamic images into data-URL lines; the caller must emit
      // those lines with image() before the model can inspect their pixels.
      text.text = text.text.replace(
        'This file is binary image data and is not readable as text. It is displayed to the user inline.',
        'Image data is attached to this result.'
      ) + '\n' + CODEX_IMAGE_READ_GUIDANCE;
    }
    return { contentItems, success: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unreadable image";
    // Never report visual success or return a partially delivered set of images.
    return { contentItems: [{ type: "inputText", text: `Image delivery failed: ${detail}. Capture or read the image again before sending GUI input.` }], success: false };
  }
}

