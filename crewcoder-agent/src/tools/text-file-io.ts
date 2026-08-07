/**
 * Single entry point for the text file I/O the `read`/`write`/`edit` tools do.
 *
 * Normally this is plain `node:fs`. When the agent runs under a host that
 * provides its own filesystem (an ACP client exposing unsaved editor buffers, or
 * a remote workspace over SFTP), `context.textFiles` overrides it per operation.
 *
 * Falling back per method — rather than all-or-nothing — matters because hosts
 * advertise read and write capabilities independently.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../core/tool-types.js";

export async function readTextFile(context: ToolContext, absolutePath: string): Promise<string> {
  const host = context.textFiles?.readTextFile;
  if (host) return await host(absolutePath);
  return await fs.readFile(absolutePath, "utf8");
}

export async function writeTextFile(context: ToolContext, absolutePath: string, content: string): Promise<void> {
  const host = context.textFiles?.writeTextFile;
  // A host filesystem owns its own directory creation; mkdir here would target
  // local disk, which may not be where the file actually lives.
  if (host) {
    await host(absolutePath, content);
    return;
  }
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}
