import type { ProviderDefinition } from "../providers/types.js";

export type CrewCoderExtensionActivation = {
  /** Lifecycle or host events that should make this extension relevant. */
  events?: string[];
  /** Prompt keywords used by prompt composition and discovery surfaces. */
  keywords?: string[];
  /** Optional mode hints such as auto/general/plugin/custom future modes. */
  modes?: string[];
  /** Optional command names that activate or expose this extension. */
  commands?: string[];
  /** Optional file globs that make this extension relevant to a workspace. */
  filePatterns?: string[];
};

export type CrewCoderExtensionNetworkPermission = {
  /** Outbound hosts the extension may contact. Exact (`api.example.com`), wildcard (`*.example.com`), or `*`. */
  allowedHosts: string[];
};

export type CrewCoderExtensionPermissions = {
  network?: CrewCoderExtensionNetworkPermission;
};

export type CrewCoderExtensionContribution = {
  id: string;
  title: string;
  description?: string;
  [key: string]: unknown;
};

export type CrewCoderExtensionHookEvent = "context" | "beforeToolCall" | "afterToolCall" | "onError" | "compaction";

export type CrewCoderExtensionHookContribution = CrewCoderExtensionContribution & {
  /** Runtime event to subscribe to. Defaults to context for executable hooks. */
  event?: CrewCoderExtensionHookEvent;
  /**
   * Optional declarative filter for tool-call events. Omitted means the hook fires for every
   * tool call and must filter the payload itself.
   */
  matches?: {
    /** Tool name patterns: substring, `*` glob, or `/regex/`. */
    tools?: string[];
    /** Path-like argument patterns, glob-matched against path args. */
    paths?: string[];
    /** Bash command patterns: substring, glob, or `/regex/`. */
    commands?: string[];
  };
  /** Executable command for trusted hook runtime. Receives JSON on stdin. */
  command?: string;
  /** Command arguments. {{json}} and {{payloadJson}} expand to the hook payload. */
  args?: string[];
  /** Extra environment values. {{json}} and {{payloadJson}} are supported. */
  env?: Record<string, string>;
  /** Per-hook timeout. Clamped by the runtime. */
  timeoutMs?: number;
};

/**
 * A workflow step is either a deterministic tool call or a model turn.
 *
 * Deliberately not a programming language: linear steps, one `when` guard, one failure
 * policy. Anything needing loops or arithmetic should be a tool, not workflow syntax.
 */
export type CrewCoderWorkflowStep = {
  /** Step-local id, referenced by `when` and `{{steps.<id>.output}}`. Defaults to the index. */
  id?: string;
  /** `tool` runs a built-in tool with fixed args. `prompt` runs one model turn. */
  kind: "tool" | "prompt";
  /** Human-readable label shown in `workflow show`. */
  title?: string;
  /** Tool name for `kind: "tool"`, e.g. bash/read/edit/git_log. */
  tool?: string;
  /** Tool arguments. String values support `{{steps.<id>.output}}` templating. */
  args?: Record<string, unknown>;
  /** Prompt text for `kind: "prompt"`. Supports the same templating. */
  prompt?: string;
  /** Restrict the model to these built-in tools for this step. Omitted means all tools. */
  allowTools?: string[];
  /** Guard: `steps.<id>.ok` or `steps.<id>.failed`. Omitted means always run. */
  when?: string;
  /** What to do when this step fails. Defaults to `stop`. */
  onFailure?: "stop" | "continue";
};

export type CrewCoderExtensionWorkflowContribution = CrewCoderExtensionContribution & {
  steps: CrewCoderWorkflowStep[];
};

export type CrewCoderExtensionRendererContribution = CrewCoderExtensionContribution & {
  kind: "renderer";
  target: "tool";
  match: {
    extensionId?: string;
    toolId?: string;
    renderer?: string;
    toolName?: string;
  };
  /** Markdown/plain-text template rendered by the TUI when match fields equal tool metadata. */
  template: string;
};

export type CrewCoderExtensionApprovalPolicyContribution = CrewCoderExtensionContribution & {
  /** Policy action. `review` forces approval; `block` prevents execution. */
  action: "allow" | "review" | "block";
  /** Optional reason shown in approval/blocked messages. */
  reason?: string;
  /** Match specific tool names, e.g. write/edit/bash/extension_pack_tool. */
  tools?: string[];
  /** Match path-like tool args (`path`, `file`, `directory`, `target`) by glob-ish pattern. */
  paths?: string[];
  /** Match bash command text by substring or `/regex/` pattern. */
  commands?: string[];
};

export type CrewCoderExtensionFileTriggerContribution = CrewCoderExtensionContribution & {
  /** Workspace-relative changed file patterns. */
  patterns: string[];
  /** Executable command. Receives trigger payload on stdin and in CREWCODER_EXTENSION_FILE_TRIGGER_PAYLOAD. */
  command: string;
  /** Command arguments. Supports {{path}}, {{toolName}}, {{cwd}}, {{sessionId}}, {{json}}, and {{payloadJson}}. */
  args?: string[];
  /** Extra environment values with the same template variables as args. */
  env?: Record<string, string>;
  /** Per-trigger timeout. */
  timeoutMs?: number;
};

export type CrewCoderLiveUiSurface = "modal" | "transcript" | "status";
export type CrewCoderLiveUiSlot = "extension-ui" | "tool-result" | "session-status" | string;
export type CrewCoderLiveUiMode = "tui";
export type CrewCoderLiveUiKind = "confirm" | "input" | "select" | "component";
export type CrewCoderLiveUiComponentKind = "markdown" | "details" | "table" | "actionList";
export type CrewCoderLiveUiPermission = "render" | "input" | "focus";
export type CrewCoderLiveUiClipboardPermission = "none" | "write" | "read";
export type CrewCoderLiveUiStoragePermission = "none" | "session";
export type CrewCoderLiveUiCommandPermission = "ui_response" | `ext.${string}`;
export type CrewCoderLiveUiEventPermission = `read:${string}`;

export type CrewCoderLiveUiJsonPrimitive = string | number | boolean | null;
export type CrewCoderLiveUiJsonValue = CrewCoderLiveUiJsonPrimitive | CrewCoderLiveUiJsonValue[] | { [key: string]: CrewCoderLiveUiJsonValue };
export type CrewCoderLiveUiJsonObject = { [key: string]: CrewCoderLiveUiJsonValue };

export type CrewCoderLiveUiActivation = {
  events?: string[];
  modes?: CrewCoderLiveUiMode[];
  commands?: string[];
  filePatterns?: string[];
};

export type CrewCoderLiveUiMatch = {
  eventTypes?: string[];
  toolNames?: string[];
  extensionIds?: string[];
  toolIds?: string[];
  renderers?: string[];
  uiKinds?: CrewCoderLiveUiKind[];
  componentKinds?: CrewCoderLiveUiComponentKind[];
};

export type CrewCoderLiveUiPermissions = {
  ui?: CrewCoderLiveUiPermission[];
  events?: CrewCoderLiveUiEventPermission[];
  commands?: CrewCoderLiveUiCommandPermission[];
  clipboard?: CrewCoderLiveUiClipboardPermission;
  network?: { allowedHosts: string[] };
  storage?: CrewCoderLiveUiStoragePermission;
};

export type CrewCoderExtensionLiveUiContribution = CrewCoderExtensionContribution & {
  /** Required marker: live UI is experimental and must be explicitly opted into. */
  experimental: true;
  /** Extension-relative TypeScript/JavaScript module path for the UI component. */
  entry: string;
  target: {
    surface: CrewCoderLiveUiSurface;
    slot?: CrewCoderLiveUiSlot;
  };
  /** Cheap relevance gate. It never loads code by itself. */
  activation?: CrewCoderLiveUiActivation;
  /** Fine-grained UI/event payload matcher checked before a host may load code. */
  match: CrewCoderLiveUiMatch;
  /** Explicit capability request. Missing capabilities are denied by default. */
  permissions: CrewCoderLiveUiPermissions;
};

export type CrewCoderLiveUiProps = {
  extensionId: string;
  contributionId: string;
  surface: CrewCoderLiveUiSurface;
  slot?: CrewCoderLiveUiSlot;
  event: {
    type: string;
    requestId?: string;
    uiKind?: CrewCoderLiveUiKind;
    title?: string;
    message?: string;
    component?: CrewCoderLiveUiJsonValue;
    metadata?: CrewCoderLiveUiJsonObject;
  };
};

export type CrewCoderLiveUiHost = {
  /** JSON protocol version for child-process hosts. */
  protocolVersion: "0.1";
  /** Stdio JSONL is the initial process-friendly transport contract. */
  transport: "stdio-jsonl";
  /** Permissions granted after trust/config/policy checks, not raw requested permissions. */
  permissions: CrewCoderLiveUiPermissions;
  limits: {
    maxRenderLines: number;
    maxLineLength: number;
    maxPayloadBytes: number;
  };
};

export type CrewCoderLiveUiInstance = {
  instanceId: string;
  extensionId: string;
  contributionId: string;
  surface: CrewCoderLiveUiSurface;
  slot?: CrewCoderLiveUiSlot;
  canReceiveInput: boolean;
};

export type CrewCoderLiveUiInputEvent = {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
};

export type CrewCoderLiveUiHostCommand =
  | { type: "notify"; message: string; level?: "info" | "success" | "warning" | "error" }
  | { type: "resolve_ui_request"; requestId: string; value: string | boolean | null }
  | { type: "request_repaint" }
  | { type: "read_session_state"; requestId: string; key: string }
  | { type: "write_session_state"; key: string; value: CrewCoderLiveUiJsonValue };

export type CrewCoderLiveUiChildMessage =
  | { type: "ready"; instance: CrewCoderLiveUiInstance }
  | { type: "rendered"; lines: string[] }
  | { type: "handled_input"; handled: boolean }
  | { type: "host_command"; command: CrewCoderLiveUiHostCommand }
  | { type: "error"; message: string };

export type CrewCoderLiveUiHostMessage =
  | { type: "init"; props: CrewCoderLiveUiProps; host: CrewCoderLiveUiHost }
  | { type: "render"; width: number; height: number }
  | { type: "input"; event: CrewCoderLiveUiInputEvent }
  | { type: "session_state"; requestId: string; value?: CrewCoderLiveUiJsonValue }
  | { type: "dispose" };

export type CrewCoderExtensionManifest = {
  id: string;
  name: string;
  version: string;
  crewcoder: { apiVersion: "0.1" };
  description?: string;
  /** Optional TypeScript/JavaScript module entry point exporting default (api: CrewCoderExtAPI) => void | Promise<void>. */
  main?: string;
  /** Extension-level capability requests. Network egress is denied unless declared here. */
  permissions?: CrewCoderExtensionPermissions;
  activation?: CrewCoderExtensionActivation;
  contributes?: {
    /** Provider adapters are loaded into the provider registry today. */
    providers?: Array<Omit<ProviderDefinition, "kind" | "extensionId">>;
    /** Prompt packs are matched by id/title and composed into the system prompt today. */
    promptPacks?: Array<{ id: string; title: string; file?: string; prompts?: Array<{ id: string; title: string; content: string }> }>;
    /** Skills are trigger-matched and composed into the system prompt today. */
    skills?: Array<{ id: string; title: string; description: string; triggers: string[]; prompt?: string }>;
    /** Tool declarations are loaded when allowExtensionTools=true and the extension is trusted. */
    tools?: Array<{ id: string; title: string; command?: string; args?: string[]; description?: string; icon?: string; category?: string; renderer?: string; [key: string]: unknown }>;
    commands?: CrewCoderExtensionContribution[];
    /** Deterministic tool+prompt sequences. Run with `crewcoder workflow run`. */
    workflows?: CrewCoderExtensionWorkflowContribution[];
    contextProviders?: CrewCoderExtensionContribution[];
    validators?: CrewCoderExtensionContribution[];
    approvalPolicies?: Array<CrewCoderExtensionContribution | CrewCoderExtensionApprovalPolicyContribution>;
    fileTriggers?: Array<CrewCoderExtensionContribution | CrewCoderExtensionFileTriggerContribution>;
    hooks?: CrewCoderExtensionHookContribution[];
    ui?: Array<CrewCoderExtensionContribution | CrewCoderExtensionRendererContribution>;
    /** Experimental contract only; CrewCoder does not load live UI code yet. */
    liveUi?: CrewCoderExtensionLiveUiContribution[];
    /** Extensions may declare future/custom contribution points without changing the core type first. */
    [contributionPoint: string]: unknown;
  };
};

export type LoadedCrewCoderExtension = {
  dir: string;
  manifest: CrewCoderExtensionManifest;
  warnings: string[];
};
