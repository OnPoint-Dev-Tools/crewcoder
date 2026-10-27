import { RequestError, type AgentSideConnection } from "@agentclientprotocol/sdk";
import { ArtifactError, ArtifactStore, ARTIFACT_FORMATS, ARTIFACT_LIMITS, artifactMetadata, assertArtifactId, parseArtifactWrite, type Artifact } from "../core/artifact-store.js";
import { textResult, type ToolDefinition } from "../core/tool-types.js";

export const CREWCODER_ARTIFACTS_META = {
  version: 1,
  listMethod: "session/artifacts/list",
  readMethod: "session/artifacts/read",
  writeMethod: "session/artifacts/write",
  notification: "_crewcoder/artifact_updated",
  formats: ARTIFACT_FORMATS,
  ...ARTIFACT_LIMITS
} as const;
export const ARTIFACT_TOOL_NAMES = ["artifact_write", "artifact_read", "artifact_list"] as const;

export async function notifyArtifact(conn: AgentSideConnection, sessionId: string, artifact: Artifact): Promise<void> {
  await conn.notify(CREWCODER_ARTIFACTS_META.notification, {
    sessionId, version: 1, action: artifact.revision === 1 ? "created" : "updated", artifact: artifactMetadata(artifact)
  });
}

export async function artifactMethod(conn: AgentSideConnection, sessionId: string, method: string, params: Record<string, unknown>, readOnly: boolean): Promise<Record<string, unknown>> {
  try {
    const store = new ArtifactStore(sessionId);
    if (params.version !== 1) throw new ArtifactError("invalid", "Artifact methods require version: 1");
    if (method === CREWCODER_ARTIFACTS_META.listMethod) return { artifacts: store.list() };
    if (method === CREWCODER_ARTIFACTS_META.readMethod) {
      assertArtifactId(params.id);
      return { artifact: store.read(params.id) };
    }
    if (readOnly) throw new ArtifactError("invalid", "Artifact writes are unavailable under hosted-text-only policy");
    const artifact = store.write(parseArtifactWrite(params));
    await notifyArtifact(conn, sessionId, artifact);
    return { artifact };
  } catch (error) {
    if (error instanceof ArtifactError) throw new RequestError(-32602, error.message, { artifactCode: error.code });
    throw error;
  }
}

/** ACP-owned tools reuse the normal provider executor, approvals, and cancellation. */
export function createArtifactTools(conn: AgentSideConnection, sessionId: string): ToolDefinition[] {
  const store = new ArtifactStore(sessionId);
  return [
    {
      name: "artifact_write",
      description: "Create or update a durable artifact in the app's artifact browser. Use html for self-contained interactive apps/charts, svg for vector graphics, mermaid for diagrams, markdown for documents. Content is source text, never executed by CrewCoder. For updates read the artifact first and pass its id and expectedRevision; provide the complete replacement source, title and format. Use inline HTML/CSS/JavaScript with no external dependencies for portable previews.",
      executionMode: "sequential",
      isMutation: true,
      parameters: { type: "object", properties: {
        id: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 },
        title: { type: "string", maxLength: 200 }, format: { type: "string", enum: [...ARTIFACT_FORMATS] },
        content: { type: "string" }
      }, required: ["title", "format", "content"], additionalProperties: false },
      parse(args) { return { ...parseArtifactWrite(args) }; },
      async execute(args, _context, signal) {
        const artifact = store.write(parseArtifactWrite(args), signal);
        await notifyArtifact(conn, sessionId, artifact);
        return textResult(JSON.stringify(artifactMetadata(artifact)), { artifact: artifactMetadata(artifact) });
      }
    },
    {
      name: "artifact_read", description: "Read the latest source and revision of an artifact in this session before editing it.",
      executionMode: "parallel",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      parse(args) { assertArtifactId(args.id); return { id: args.id }; },
      async execute(args, _context, signal) { signal?.throwIfAborted(); return textResult(JSON.stringify(store.read(String(args.id)))); }
    },
    {
      name: "artifact_list", description: "List this session's saved artifact metadata and revisions; read an artifact to retrieve its source.",
      executionMode: "parallel",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      parse() { return {}; },
      async execute(_args, _context, signal) { signal?.throwIfAborted(); return textResult(JSON.stringify(store.list())); }
    }
  ];
}
