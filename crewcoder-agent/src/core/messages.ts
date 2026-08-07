import path from "node:path";

export type TextPart = { type: "text"; text: string };
export type ToolCallPart = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
// Image input for vision-capable providers. `path` points at an on-disk file
// (the TUI persists pasted screenshots to the CrewCoder cache); provider adapters
// read the bytes and encode them at request time. Storing the path — not base64 —
// keeps session records small and durable.
export type ImagePart = { type: "image"; mime: string; path: string; width?: number; height?: number };
export type MessageContent = TextPart | ToolCallPart | ImagePart;
export type UserMessage = { role: "user"; content: MessageContent[]; timestamp: number; background?: string[] };
export type AssistantMessage = { role: "assistant"; content: MessageContent[]; stopReason: "end" | "tool_calls" | "error" | "aborted"; timestamp: number; errorMessage?: string; id?: string; promptHash?: string; responseHash?: string };
export type ToolResultMessage = { role: "toolResult"; toolCallId: string; toolName: string; content: TextPart[]; isError: boolean; terminate?: boolean; timestamp: number; details?: Record<string, unknown> };
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;
export function textMessage(role: "user", text: string): UserMessage { return { role, content: [{ type: "text", text }], timestamp: Date.now() }; }
export function assistantText(text: string, stopReason: AssistantMessage["stopReason"] = "end"): AssistantMessage { return { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now() }; }
export function getText(message: AgentMessage): string {
  const textParts: TextPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") textParts.push(part);
  }
  return textParts.map((part) => part.text).join("\n");
}

export function renderMessagesForModel(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || !message.background?.length) return message;
    const text = getText(message);
    const background = message.background.map((item) => item.trim()).filter(Boolean).join("\n\n");
    if (!background) return message;
    // Preserve image parts; only the text is merged with background context.
    const imageParts = message.content.filter((part): part is ImagePart => part.type === "image");
    return {
      ...message,
      content: [{ type: "text", text: `${text}\n\nBackground:\n${background}` }, ...imageParts]
    };
  });
}

const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp"
};

/** Build an image content part from a file path, inferring mime from the extension. */
export function imagePartFromPath(filePath: string): ImagePart {
  const mime = EXTENSION_MIME[path.extname(filePath).toLowerCase()] ?? "image/png";
  return { type: "image", mime, path: filePath };
}

/** Attach image parts (by path) to a user message's content. */
export function withImageParts(message: UserMessage, imagePaths: string[]): UserMessage {
  if (!imagePaths.length) return message;
  return { ...message, content: [...message.content, ...imagePaths.map(imagePartFromPath)] };
}
