import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { JsonObjectSchema, JsonSchema, ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";

/** Advertised on `initialize._meta` so a host can replace virtual-file command protocols with typed tools. */
export const CREWCODER_CLIENT_TOOLS_META = {
  method: "session/set_client_tools",
  callMethod: "crewcoder/client_tool/call",
  version: 1,
  maxTools: 32
} as const;

export type ClientToolDefinition = { name: string; description: string; inputSchema: JsonObjectSchema };

const NAME = /^[a-z][a-z0-9_]{2,63}$/;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_SCHEMA_DEPTH = 6;
const MAX_RESULT_CHARS = 50_000;

/**
 * Only the JSON Schema subset every provider adapter can translate (the Claude SDK path converts it to
 * zod), so a host cannot hand CrewCoder a schema that one provider silently drops.
 */
function assertSchema(schema: unknown, path: string, depth: number): asserts schema is JsonSchema {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`${path} nests too deeply`);
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`${path} must be a schema object`);
  const value = schema as Record<string, unknown>;
  const allowed = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path} uses unsupported keyword "${key}"`);
  if (value.description !== undefined && typeof value.description !== "string") throw new Error(`${path}.description must be a string`);
  switch (value.type) {
    case "object": {
      const properties = value.properties ?? {};
      if (typeof properties !== "object" || Array.isArray(properties)) throw new Error(`${path}.properties must be an object`);
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) assertSchema(child, `${path}.properties.${name}`, depth + 1);
      if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((entry) => typeof entry !== "string" || !(entry in (properties as object))))) throw new Error(`${path}.required must list declared properties`);
      if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") throw new Error(`${path}.additionalProperties must be a boolean`);
      return;
    }
    case "array":
      if (value.items !== undefined) assertSchema(value.items, `${path}.items`, depth + 1);
      return;
    case "string":
      if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.some((entry) => typeof entry !== "string"))) throw new Error(`${path}.enum must be a non-empty string array`);
      return;
    case "number":
    case "integer":
    case "boolean":
      return;
    default:
      throw new Error(`${path}.type must be object, array, string, number, integer, or boolean`);
  }
}

/** Validates `session/set_client_tools` input. Names may not shadow tools CrewCoder already provides. */
export function parseClientToolDefinitions(raw: unknown, reservedNames: ReadonlySet<string>): ClientToolDefinition[] {
  if (!Array.isArray(raw)) throw new Error("tools must be an array");
  if (raw.length > CREWCODER_CLIENT_TOOLS_META.maxTools) throw new Error(`at most ${CREWCODER_CLIENT_TOOLS_META.maxTools} client tools are supported`);
  const seen = new Set<string>();
  return raw.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") throw new Error(`tools[${index}] must be an object`);
    const { name, description, inputSchema } = candidate as Record<string, unknown>;
    if (typeof name !== "string" || !NAME.test(name)) throw new Error(`tools[${index}].name must match ${NAME.source}`);
    if (reservedNames.has(name)) throw new Error(`tools[${index}].name "${name}" collides with a CrewCoder tool`);
    if (seen.has(name)) throw new Error(`tools[${index}].name "${name}" is repeated`);
    seen.add(name);
    if (typeof description !== "string" || !description.trim() || description.length > MAX_DESCRIPTION_CHARS) throw new Error(`tools[${index}].description must be 1 to ${MAX_DESCRIPTION_CHARS} characters`);
    assertSchema(inputSchema, `tools[${index}].inputSchema`, 0);
    if ((inputSchema as JsonSchema & { type?: string }).type !== "object") throw new Error(`tools[${index}].inputSchema must be an object schema`);
    return { name, description, inputSchema: inputSchema as JsonObjectSchema };
  });
}

type ClientToolCallResult = { content?: unknown; isError?: unknown };

const resultText = (result: ClientToolCallResult): string => {
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) return result.content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
  return "";
};

/**
 * Tools whose execution belongs to the ACP client. The client is the authority: it checks grants, asks
 * for approval, and audits, so CrewCoder neither approves nor checkpoints these calls itself.
 */
export function clientHostedTools(conn: AgentSideConnection, sessionId: string, definitions: readonly ClientToolDefinition[]): ToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    // The host may wait on a human approval; parallel calls would interleave those prompts.
    executionMode: "sequential",
    isMutation: false,
    parse(args) {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`${definition.name} arguments must be an object`);
      return args;
    },
    async execute(args) {
      const result = await conn.request<ClientToolCallResult>(CREWCODER_CLIENT_TOOLS_META.callMethod, { sessionId, name: definition.name, arguments: args });
      const text = resultText(result).slice(0, MAX_RESULT_CHARS);
      if (result.isError === true) throw new Error(text || `${definition.name} failed`);
      return textResult(text || "(no output)");
    }
  }));
}
