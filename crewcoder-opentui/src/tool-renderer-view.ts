import { renderToolTemplate } from "@onpoint-dev-tools/crewcoder-tui-core/state/tool-renderers";
import type { TuiRendererHook } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { normalize, type ToolBlock } from "./transcript.js";

/**
 * What an extension tool renderer draws (`docs/TRANSCRIPT.md#extension-tool-renderers`):
 * its title, the extension it came from, and the filled-in template. Agent and extension
 * text go through `normalize()`, like every other transcript text. Pure.
 */
export type RenderedToolView = { title: string; source: string; body: string };

export function renderedTool(block: ToolBlock, renderer: TuiRendererHook): RenderedToolView {
  return {
    title: normalize(renderer.title).trim() || block.name,
    source: normalize(renderer.extensionId),
    body: normalize(renderToolTemplate(renderer.template, block)).trim()
  };
}
