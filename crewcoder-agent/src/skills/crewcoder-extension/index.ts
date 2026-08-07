import { createSkill } from "../types.js";

/**
 * Skill pack for **CrewCoder extension** authoring (`crewcoder.extension.json`).
 *
 * Separate from `../crewcode/index.ts`, which covers CrewCode *app plugins*. Do not
 * merge the two packs: they describe different manifests and different trust models.
 */
export const crewcoderExtensionSkills = [
  createSkill("crewcoder.extension.manifest", "Generate and validate crewcoder.extension.json manifests.", ["crewcoder.extension.json", "extension manifest", "apiversion", "manifest id"]),
  createSkill("crewcoder.extension.contributions", "Choose the right contribution points for an extension.", ["contributes", "contribution point", "contextproviders", "validators", "promptpacks"]),
  createSkill("crewcoder.extension.trust", "Apply trust tiers and capability config flags correctly.", ["trust", "tier", "prompt-only", "sandboxed", "trusted", "allowextensiontools", "allowextensionmodules", "allowextensionhooks"]),
  createSkill("crewcoder.extension.hooks", "Author context, beforeToolCall, afterToolCall, onError, and compaction hooks.", ["hook", "beforetoolcall", "aftertoolcall", "onerror", "compaction", "matches"]),
  createSkill("crewcoder.extension.approval-policies", "Author approval policies and file triggers.", ["approvalpolicies", "approval policy", "filetriggers", "file trigger"]),
  createSkill("crewcoder.extension.workflows", "Author deterministic tool/prompt workflows.", ["workflow", "steps", "onfailure", "workflow run"]),
  createSkill("crewcoder.extension.modules", "Write CrewCoderExtAPI module entry points.", ["crewcoderextapi", "definetool", "definecommand", "handleevent", "agent_event", "writesessionentry"]),
  createSkill("crewcoder.extension.providers", "Contribute provider adapters through an extension.", ["provider contribution", "provider adapter", "extension provider"]),
  createSkill("crewcoder.extension.skills", "Contribute skills and prompt packs with correct activation triggers.", ["extension skill", "promptpack", "trigger", "activation"]),
  createSkill("crewcoder.extension.tools", "Contribute namespaced extension tools safely.", ["extension tool", "namespaced tool", "extension_"]),
  createSkill("crewcoder.extension.ui", "Contribute declarative tool renderers and interactive UI.", ["renderer", "ctx.ui", "liveui", "notify"]),
  createSkill("crewcoder.extension.distribution", "Install, update, trust, and publish extensions to a registry.", ["extension install", "extension update", "uninstall", "registry", "extension search"])
];
