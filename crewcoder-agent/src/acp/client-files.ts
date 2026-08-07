/**
 * Routes CrewCoder's text file I/O through the ACP client.
 *
 * Clients advertise `fs.readTextFile` / `fs.writeTextFile` during `initialize`.
 * When they do, the client is the authority on file contents — it can serve
 * unsaved editor buffers, and (in CrewCode's case) proxy a remote workspace over
 * SFTP. Going to local disk instead would read stale bytes or miss the file
 * entirely.
 *
 * The two capabilities are independent, so each method is wired only if the
 * client actually claimed it; anything unclaimed falls back to local disk.
 */
import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
import type { TextFileHost } from "../core/tool-types.js";

export function createClientTextFileHost(
  conn: AgentSideConnection,
  sessionId: string,
  capabilities: ClientCapabilities | undefined
): TextFileHost | undefined {
  const fs = capabilities?.fs;
  if (!fs?.readTextFile && !fs?.writeTextFile) return undefined;

  const host: TextFileHost = {};
  if (fs.readTextFile) {
    host.readTextFile = async (absolutePath) => {
      const response = await conn.readTextFile({ sessionId, path: absolutePath });
      return response.content;
    };
  }
  if (fs.writeTextFile) {
    host.writeTextFile = async (absolutePath, content) => {
      await conn.writeTextFile({ sessionId, path: absolutePath, content });
    };
  }
  return host;
}
