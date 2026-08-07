import fs from "node:fs/promises";
import path from "node:path";
import { listEnabledExtensions } from "./extension-registry.js";
import type { LoadedCrewCoderExtension } from "./types.js";

/**
 * Extension prompt/skill activation for the prompt composer.
 *
 * Enabled CrewCoder extensions can contribute `skills` (trigger-matched
 * instruction packs) and `promptPacks` (reusable prompt snippets). Until now
 * these were loaded but never reached the model. This module matches those
 * contributions against the current user prompt and renders a compact system
 * prompt section so the agent loop can compose them in.
 *
 * Activation rules are deliberately deterministic so they are easy to test:
 *   - A contributed skill activates when any of its `triggers` appears as a
 *     case-insensitive substring of the prompt.
 *   - A contributed prompt activates when the prompt references the pack id,
 *     prompt id, pack title, or prompt title (case-insensitive substring).
 *   - All enabled extension skills are always listed as "available" metadata so
 *     unmatched skills remain discoverable without dumping their full body.
 */

export type ActivatedExtensionSkill = {
  extensionId: string;
  id: string;
  title: string;
  description: string;
  triggers: string[];
  prompt?: string;
  activated: boolean;
};

export type ActivatedExtensionPrompt = {
  extensionId: string;
  packId: string;
  packTitle: string;
  promptId: string;
  promptTitle: string;
  content: string;
};

export type ExtensionActivation = {
  skills: ActivatedExtensionSkill[];
  prompts: ActivatedExtensionPrompt[];
};

type PromptPackPrompt = { id: string; title: string; content: string };

function includesAny(haystack: string, needles: Array<string | undefined>): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => {
    const trimmed = needle?.trim().toLowerCase();
    return Boolean(trimmed) && lower.includes(trimmed as string);
  });
}

/**
 * Pure activation over already-loaded extensions. Prompt-pack `file` references
 * must be resolved before calling this; inline `prompts` are used as-is.
 */
export function activateExtensionContributions(
  extensions: LoadedCrewCoderExtension[],
  prompt: string,
  resolvedPackPrompts: Map<string, PromptPackPrompt[]> = new Map()
): ExtensionActivation {
  const skills: ActivatedExtensionSkill[] = [];
  const prompts: ActivatedExtensionPrompt[] = [];

  for (const extension of extensions) {
    const extensionId = extension.manifest.id;

    for (const skill of extension.manifest.contributes?.skills ?? []) {
      const triggers = skill.triggers ?? [];
      skills.push({
        extensionId,
        id: skill.id,
        title: skill.title,
        description: skill.description,
        triggers,
        prompt: skill.prompt,
        activated: includesAny(prompt, triggers)
      });
    }

    for (const pack of extension.manifest.contributes?.promptPacks ?? []) {
      const packPrompts = resolvedPackPrompts.get(`${extensionId}:${pack.id}`) ?? pack.prompts ?? [];
      for (const packPrompt of packPrompts) {
        const matched = includesAny(prompt, [pack.id, pack.title, packPrompt.id, packPrompt.title]);
        if (!matched) continue;
        prompts.push({
          extensionId,
          packId: pack.id,
          packTitle: pack.title,
          promptId: packPrompt.id,
          promptTitle: packPrompt.title,
          content: packPrompt.content
        });
      }
    }
  }

  return { skills, prompts };
}

/**
 * Load enabled extensions, resolve prompt-pack file references, and activate
 * their contributions against the prompt. Returns an empty activation when no
 * extensions are enabled or none contribute skills/prompts.
 */
export async function activateEnabledExtensions(prompt: string): Promise<ExtensionActivation> {
  const enabled = await listEnabledExtensions();
  if (enabled.length === 0) return { skills: [], prompts: [] };

  const resolved = new Map<string, PromptPackPrompt[]>();
  for (const extension of enabled) {
    for (const pack of extension.manifest.contributes?.promptPacks ?? []) {
      if (!pack.file) continue;
      const filePrompt = await loadPromptPackFile(extension.dir, pack.file, pack.id, pack.title);
      if (filePrompt) resolved.set(`${extension.manifest.id}:${pack.id}`, [...(pack.prompts ?? []), filePrompt]);
    }
  }

  return activateExtensionContributions(enabled, prompt, resolved);
}

async function loadPromptPackFile(
  dir: string,
  file: string,
  packId: string,
  packTitle: string
): Promise<PromptPackPrompt | undefined> {
  // Guard against path traversal outside the extension directory.
  const resolved = path.resolve(dir, file);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return undefined;
  try {
    const content = (await fs.readFile(resolved, "utf8")).trim();
    if (!content) return undefined;
    return { id: `${packId}.file`, title: packTitle, content };
  } catch {
    return undefined;
  }
}

/**
 * Render the activated contributions into a system prompt section. Returns an
 * empty string when there is nothing to compose so the composer can omit it.
 */
export function formatExtensionActivation(activation: ExtensionActivation): string {
  const lines: string[] = [];

  if (activation.skills.length) {
    lines.push("Available extension skills:");
    for (const skill of activation.skills) {
      const flag = skill.activated ? " (active)" : "";
      lines.push(`- ${skill.extensionId}/${skill.id}${flag}: ${skill.description}`);
    }
  }

  const activeSkillBodies = activation.skills.filter((skill) => skill.activated && skill.prompt?.trim());
  if (activeSkillBodies.length) {
    lines.push("", "Activated extension skill instructions:");
    for (const skill of activeSkillBodies) {
      lines.push(`[${skill.extensionId}/${skill.id}] ${skill.title}`, (skill.prompt as string).trim());
    }
  }

  if (activation.prompts.length) {
    lines.push("", "Activated extension prompts:");
    for (const prompt of activation.prompts) {
      lines.push(`[${prompt.extensionId}/${prompt.packId}/${prompt.promptId}] ${prompt.promptTitle}`, prompt.content.trim());
    }
  }

  return lines.join("\n").trim();
}

/** Convenience: stable ids of the contributions that actually activated. */
export function activatedContributionIds(activation: ExtensionActivation): string[] {
  return [
    ...activation.skills.filter((skill) => skill.activated).map((skill) => `${skill.extensionId}/${skill.id}`),
    ...activation.prompts.map((prompt) => `${prompt.extensionId}/${prompt.packId}/${prompt.promptId}`)
  ];
}
