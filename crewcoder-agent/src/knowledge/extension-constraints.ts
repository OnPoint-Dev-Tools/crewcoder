/**
 * Hard constraints for **CrewCoder extensions**.
 *
 * The CrewCode app plugin equivalents live in `constraints.ts`. Keep them apart:
 * `crewcoder.extension.json` and `crewcode.plugin.json` are different manifests,
 * different install roots, and different trust models.
 */
export const CREWCODER_EXTENSION_CONSTRAINTS = [
  "CrewCoder extensions extend CrewCoder itself and are never CrewCode app plugins.",
  "Every extension requires crewcoder.extension.json with id, name, version, and crewcoder.apiVersion.",
  "Current supported crewcoder.apiVersion is 0.1.",
  "Extensions install to <crewcoder-home>/extensions/<extension-id>, never under /.crewcode.",
  "The install directory name must equal manifest.id; trust and enablement key off that id.",
  "Extensions are capability-based; do not reintroduce extension kinds such as provider, skill-pack, or prompt-pack.",
  "Installing an extension never grants trust; everything executable stays inert at the default prompt-only tier.",
  "Trust tiers are prompt-only (default), sandboxed, and trusted.",
  "Extension tools require allowExtensionTools=true and a trusted extension id.",
  "Module entry points (main) require allowExtensionModules=true and the trusted tier.",
  "Hooks, approvalPolicies, and fileTriggers require allowExtensionHooks=true and the trusted tier.",
  "Extension tool names are namespaced extension_<extension-id>_<tool-id> and execute without a shell.",
  "Extension commands are namespaced ext.<extension-id>.<command-id>.",
  "Network egress is denied unless declared in permissions.network.allowedHosts.",
  "A hook with no matches filter matches every tool call; an approval policy with no matchers matches nothing.",
  "Workflows are linear tool/prompt steps with no loops or arithmetic; any tool step requires sandboxed or trusted.",
  "liveUi is an experimental contract only; CrewCoder does not load live UI code."
];

export const SUPPORTED_EXTENSION_CONTRIBUTION_POINTS = [
  "providers",
  "skills",
  "promptPacks",
  "tools",
  "commands",
  "workflows",
  "contextProviders",
  "validators",
  "approvalPolicies",
  "fileTriggers",
  "hooks",
  "ui",
  "liveUi"
];

/** Contribution points the runtime actually loads today, as opposed to accepted-but-inert. */
export const ACTIVE_EXTENSION_CONTRIBUTION_POINTS = [
  "providers",
  "skills",
  "promptPacks",
  "commands",
  "workflows",
  "hooks",
  "approvalPolicies",
  "fileTriggers",
  "tools",
  "ui"
];

export const EXTENSION_TRUST_TIERS = ["prompt-only", "sandboxed", "trusted"];

export const EXTENSION_HOOK_EVENTS = [
  "context",
  "beforeToolCall",
  "afterToolCall",
  "onError",
  "compaction"
];
