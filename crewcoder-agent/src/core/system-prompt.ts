import type { ResolvedAgentMode } from "./types.js";
import { CREWCODE_V0_CONSTRAINTS } from "../knowledge/constraints.js";
import { CREWCODER_EXTENSION_CONSTRAINTS } from "../knowledge/extension-constraints.js";
import type { Skill } from "../skills/types.js";
import type { EmbeddedDoc } from "../knowledge/crewcode-docs.js";

export function buildSystemPrompt(input: {
  mode: ResolvedAgentMode;
  skills: Skill[];
  docs: EmbeddedDoc[];
  projectContext?: string;
  sessionContext?: string;
  identityPrompt?: string | null;
  crewTasksPrompt?: string | null;
  extensionContext?: string | null;
}): string {
  const modePrompt =
    input.mode === "plugin"
      ? [
          "You are in CrewCode Plugin Architect mode.",
          "You specialize in CrewCode plugins, manifests, contribution points, permissions, provider plugins, MCP declarations, sandboxed iframes, and plugin validation.",
          "CrewCode v0 constraints are law:",
          ...CREWCODE_V0_CONSTRAINTS.map((item) => `- ${item}`),
        ]
    : input.mode === "extension"
      ? [
          "You are in CrewCoder Extension Architect mode.",
          "You specialize in CrewCoder extensions: crewcoder.extension.json manifests, contribution points, trust tiers, hooks, approval policies, workflows, CrewCoderExtAPI modules, and extension distribution.",
          "You are extending CrewCoder itself. This is NOT the CrewCode desktop app plugin system: never emit crewcode.plugin.json, plugin permissions, or iframe/panel concepts here.",
          "CrewCoder extension constraints are law:",
          ...CREWCODER_EXTENSION_CONSTRAINTS.map((item) => `- ${item}`),
        ]
      : [
          "You are in General Coding Agent mode.",
          "You are an expert coding assistant operating inside CrewCoder, a local coding agent harness.",
          "You have full local access: read and search files, run commands, edit code, create files, and use any other tool available to you.",
          "Ground your work in what you actually observed, never in what you assumed. Read a file before you change it, and get the real error message before you fix anything — one true error beats six blind guesses.",
          "You're not here to impress. You're here to be useful, honest, and real. If that means pushing back, you push back. If that means saying \"I don't know\", you say it.",
          "Never claim you finished something you didn't. Verify it first, then report what you actually changed and what still needs doing.",
        ];
  const identity = input.identityPrompt && input.identityPrompt.trim() ? [input.identityPrompt.trim(), ""] : [];
  const crewTasks = input.crewTasksPrompt && input.crewTasksPrompt.trim() ? [input.crewTasksPrompt.trim()] : [];
  // Only plugin-mode skill packs are auto-injected. In general mode this is empty
  // and the section is omitted entirely — general skills are on-demand via /skills.
  const skills = input.skills.length
    ? ["Activated skills:", ...input.skills.map((skill) => `- ${skill.id}: ${skill.description}`)]
    : [];
  // Only a static id catalog goes in the prompt — deliberately not per-prompt matched
  // summaries. Keyword matching put the *most* tokens on the *least* relevant prompts
  // (a miss fell back to dumping most of the set) and hid docs the matcher missed. A
  // fixed id list is ~70 tokens, deterministic, and shows the model the whole menu.
  // Bodies (manifests, code, recipes) live on EmbeddedDoc.content, fetched on demand.
  const docsHeading = input.mode === "extension" ? "Embedded CrewCoder extension docs:" : "Embedded CrewCode plugin docs:";
  const docs = input.docs.length
    ? [
        docsHeading,
        input.docs.map((doc) => doc.id).join(", "),
        'Call the `docs` tool with { "id": "<id>" } to read one in full (manifest examples, working code, build steps). Do this BEFORE writing a manifest rather than guessing field names.'
      ]
    : [];
  // Enabled-extension skills/prompt packs activated by the prompt composer.
  const extensions = input.extensionContext && input.extensionContext.trim() ? [input.extensionContext.trim()] : [];
  const project = input.projectContext ? ["Project inspection:", input.projectContext] : [];
  const session = input.sessionContext ? ["Session background:", input.sessionContext] : [];
  return [...modePrompt, ...identity, "", ...crewTasks, "", ...skills, "", ...extensions, "", ...docs, "", ...project, "", ...session]
    .join("\n")
    .trim();
}

export function appendCustomSystemPrompt(defaultPrompt: string, customPrompt?: string | null): string {
  const base = defaultPrompt.trim();
  const custom = customPrompt?.trim();
  if (!custom) return base;
  return [base, "Custom system prompt:", custom].join("\n\n");
}
