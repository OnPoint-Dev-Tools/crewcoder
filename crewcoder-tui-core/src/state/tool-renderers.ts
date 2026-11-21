import type { TuiEventBlock, TuiRendererHook, TuiRendererMatch } from "./tui-store.js";

/**
 * Declarative extension tool renderers (`contributes.renderers`, listed by
 * `crewcoder extension renderers --json`): a matching tool result is drawn from the
 * renderer's markdown template instead of its raw output. Templates only substitute
 * values (`{{name}}`, `{{status}}`, `{{text}}`, `{{args.x}}`, `{{metadata.x}}`); no
 * extension code runs. Shared by the legacy and OpenTUI UIs.
 */

type ToolBlock = Extract<TuiEventBlock, { type: "tool" }>;

/** The first tool renderer whose match fits the block, if any. */
export function findToolRenderer(block: ToolBlock, renderers: readonly TuiRendererHook[]): TuiRendererHook | undefined {
  return renderers.find((renderer) => renderer.target === "tool" && rendererMatchesTool(renderer.match, block));
}

/**
 * Every field the match sets must equal the tool's (metadata ids, renderer, or tool name).
 * A match that sets nothing matches nothing: otherwise one extension would redraw, and
 * could hide, every tool's output.
 */
export function rendererMatchesTool(match: TuiRendererMatch, block: ToolBlock): boolean {
  if (match.extensionId === undefined && match.toolId === undefined && match.renderer === undefined && match.toolName === undefined) return false;
  const metadata = block.metadata ?? {};
  if (match.extensionId !== undefined && metadata.extensionId !== match.extensionId) return false;
  if (match.toolId !== undefined && metadata.toolId !== match.toolId) return false;
  if (match.renderer !== undefined && metadata.renderer !== match.renderer) return false;
  if (match.toolName !== undefined && block.name !== match.toolName) return false;
  return true;
}

/** The template with every `{{ path }}` replaced; unknown paths become empty. */
export function renderToolTemplate(template: string, block: ToolBlock): string {
  return template.replaceAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_placeholder, rawPath: string) => templateValue(rawPath, block));
}

function templateValue(path: string, block: ToolBlock): string {
  if (path === "name") return block.name;
  if (path === "status") return block.status;
  if (path === "text") return block.text ?? "";
  if (path.startsWith("metadata.")) return stringifyTemplateValue(nestedValue(block.metadata, path.slice("metadata.".length)));
  if (path.startsWith("args.")) return stringifyTemplateValue(nestedValue(block.args, path.slice("args.".length)));
  return "";
}

function nestedValue(record: Record<string, unknown> | undefined, path: string): unknown {
  if (!record) return undefined;
  let current: unknown = record;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
