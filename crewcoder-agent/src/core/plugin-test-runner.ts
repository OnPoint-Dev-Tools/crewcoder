import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { PLUGIN_TEST_SANDBOX_SOURCE } from "./plugin-test-sandbox.js";
import { invokePluginCapability, isAlwaysDeniedMethod, isPluginInvokeMethod, METHOD_PERMISSIONS, type PluginInvokeResult } from "./plugin-host-contract.js";

/** A `<script>` recovered from a panel entry, in document order. */
export type PluginScript = { name: string; code: string };

export type PluginEntryRef = { contribution: string; id: string; title: string; entry: string };

/** One capability call the plugin actually made, and what the host answered. */
export type PluginCapabilityCall = {
  method: string;
  params?: Record<string, unknown>;
  ok: boolean;
  error?: string;
  /** Set when the call failed *because the manifest lacks the permission*. */
  missingPermission?: string;
};

export type PluginRuntimeError = { phase: string; message: string; stack?: string };

export type PluginTestFinding = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
};

export type PluginEntryReport = {
  entry: PluginEntryRef;
  ok: boolean;
  loaded: boolean;
  scripts: string[];
  /** Ids the smoke script clicked, and whether the plugin had a handler bound. */
  interactions: Array<{ target: string; dispatched: boolean }>;
  calls: PluginCapabilityCall[];
  runtimeErrors: PluginRuntimeError[];
  domFeatures: string[];
  findings: PluginTestFinding[];
  durationMs: number;
};

export type PluginTestReport = {
  pluginId: string;
  pluginDir: string;
  workspaceRoot: string;
  permissions: string[];
  ok: boolean;
  entries: PluginEntryReport[];
  findings: PluginTestFinding[];
  /** Always present: this harness is not a browser and the report must say so. */
  limitations: string[];
};

export type PluginTestOptions = {
  pluginDir: string;
  /** Workspace the sandboxed host is rooted at. Defaults to a scratch fixture. */
  workspaceRoot?: string;
  /** Per-entry wall-clock ceiling. */
  timeoutMs?: number;
  /** Restrict the run to one contribution entry path. */
  entry?: string;
  /** Injectable for tests; defaults to a real `worker_threads` Worker. */
  createWorker?: (source: string, workerData: Record<string, unknown>) => WorkerLike;
};

/** The slice of `worker_threads.Worker` this runner uses. */
export type WorkerLike = {
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  postMessage(value: unknown): void;
  terminate(): Promise<unknown> | unknown;
};

export const PLUGIN_TEST_LIMITATIONS = [
  "The sandbox is a stub DOM, not a browser: no layout, CSS, real event bubbling, or rendering is exercised.",
  "A passing run proves the plugin loads, binds handlers, and speaks the v0 capability protocol correctly. It does not prove the panel looks or behaves correctly on screen.",
  "Panel HTML is not parsed; element ids are materialized on first lookup, so a typo in an id is not detected here.",
  "Network and secrets are denied by the real host in API v0, so no outbound traffic is possible from a plugin under test."
];

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runPluginTest(options: PluginTestOptions): Promise<PluginTestReport> {
  const pluginDir = path.resolve(options.pluginDir);
  const manifest = readManifest(pluginDir);
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.filter((entry): entry is string => typeof entry === "string") : [];
  const pluginId = typeof manifest.id === "string" ? manifest.id : path.basename(pluginDir);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? pluginDir);

  const entries = collectEntries(manifest).filter((entry) => !options.entry || entry.entry === options.entry);
  const findings: PluginTestFinding[] = [];
  if (!entries.length) {
    findings.push({
      severity: "info",
      code: "no-ui-entries",
      message: options.entry
        ? `No contribution entry matches ${options.entry}.`
        : "This plugin contributes no tabs or sidebar panels, so there is no UI to smoke test. Manifest-only contributions (mcpServers, agentProviders) are validated by `plugin validate`."
    });
  }

  const entryReports: PluginEntryReport[] = [];
  for (const entry of entries) {
    entryReports.push(await runEntry({ entry, pluginDir, pluginId, permissions, workspaceRoot, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, createWorker: options.createWorker ?? defaultCreateWorker }));
  }

  return {
    pluginId,
    pluginDir,
    workspaceRoot,
    permissions,
    ok: entryReports.every((report) => report.ok) && !findings.some((finding) => finding.severity === "error"),
    entries: entryReports,
    findings,
    limitations: PLUGIN_TEST_LIMITATIONS
  };
}

async function runEntry(input: {
  entry: PluginEntryRef;
  pluginDir: string;
  pluginId: string;
  permissions: string[];
  workspaceRoot: string;
  timeoutMs: number;
  createWorker: NonNullable<PluginTestOptions["createWorker"]>;
}): Promise<PluginEntryReport> {
  const started = Date.now();
  const calls: PluginCapabilityCall[] = [];
  const runtimeErrors: PluginRuntimeError[] = [];
  const interactions: Array<{ target: string; dispatched: boolean }> = [];
  let domFeatures: string[] = [];
  let loaded = false;

  const entryPath = path.join(input.pluginDir, input.entry.entry);
  let scripts: PluginScript[];
  try {
    scripts = extractScripts(entryPath, input.pluginDir);
  } catch (error) {
    return {
      entry: input.entry,
      ok: false,
      loaded: false,
      scripts: [],
      interactions,
      calls,
      runtimeErrors: [{ phase: "load", message: error instanceof Error ? error.message : String(error) }],
      domFeatures,
      findings: [{ severity: "error", code: "entry-unreadable", message: `Could not load entry ${input.entry.entry}: ${error instanceof Error ? error.message : String(error)}` }],
      durationMs: Date.now() - started
    };
  }

  const worker = input.createWorker(PLUGIN_TEST_SANDBOX_SOURCE, {
    pluginId: input.pluginId,
    entry: input.entry.entry,
    scripts,
    scriptTimeoutMs: Math.min(input.timeoutMs, 5000)
  });

  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  let snapshotResolve: ((elements: SnapshotElement[]) => void) | undefined;

  const handleMessage = (raw: unknown): void => {
    const message = raw as Record<string, unknown>;
    const kind = String(message?.kind ?? "");
    if (kind === "ready") {
      loaded = true;
      domFeatures = Array.isArray(message.domFeatures) ? (message.domFeatures as string[]) : [];
      readyResolve?.();
      return;
    }
    if (kind === "snapshot-result") {
      snapshotResolve?.(Array.isArray(message.elements) ? (message.elements as SnapshotElement[]) : []);
      return;
    }
    if (kind === "runtime-error") {
      runtimeErrors.push({ phase: String(message.phase ?? "unknown"), message: String(message.message ?? "unknown error"), stack: typeof message.stack === "string" ? message.stack : undefined });
      return;
    }
    if (kind === "click-result") {
      interactions.push({ target: String(message.target ?? ""), dispatched: Boolean(message.dispatched) });
      return;
    }
    if (kind === "plugin-message") {
      handlePluginMessage(message.data, { worker, permissions: input.permissions, workspaceRoot: input.workspaceRoot, calls, runtimeErrors });
      return;
    }
  };

  worker.on("message", handleMessage);
  worker.on("error", (error: Error) => {
    runtimeErrors.push({ phase: "worker", message: error?.message ?? String(error), stack: error?.stack });
    readyResolve?.();
  });

  try {
    await withTimeout(ready, input.timeoutMs, "plugin scripts did not finish loading");

    // The real host posts context on iframe load; everything a panel does keys
    // off that message, so it is the first and most important scripted step.
    worker.postMessage({
      kind: "frame-message",
      data: {
        type: "crewcode:context",
        pluginId: input.pluginId,
        registrationId: `${input.pluginId}:${input.entry.id}`,
        workspace: { id: "smoke-workspace", name: path.basename(input.workspaceRoot), kind: "local" },
        permissions: input.permissions,
        openContext: { source: "plugin-menu" }
      }
    });
    await settle();

    // Then exercise the real controls. We ask the sandbox which elements the
    // plugin actually bound a click handler to rather than clicking every id the
    // source mentions — most of those are display nodes, and clicking them would
    // report a "dead control" for every healthy plugin.
    const snapshot = await requestSnapshot(worker, () => new Promise<SnapshotElement[]>((resolve) => { snapshotResolve = resolve; }), input.timeoutMs);
    for (const element of snapshot.filter((entry) => entry.listeners?.includes("click"))) {
      worker.postMessage({ kind: "click", target: element.id });
      await settle();
    }
    await settle(50);
  } catch (error) {
    runtimeErrors.push({ phase: "harness", message: error instanceof Error ? error.message : String(error) });
  } finally {
    await worker.terminate();
  }

  const findings = buildEntryFindings({ entry: input.entry, loaded, calls, runtimeErrors, interactions, permissions: input.permissions });
  return {
    entry: input.entry,
    // Driven by findings, not raw runtime errors: a runtime error attributed to
    // an unstubbed browser API is downgraded to a warning above and must not
    // fail the run.
    ok: loaded && !findings.some((finding) => finding.severity === "error"),
    loaded,
    scripts: scripts.map((script) => script.name),
    interactions,
    calls,
    runtimeErrors,
    domFeatures,
    findings,
    durationMs: Date.now() - started
  };
}

/**
 * Answer a plugin request exactly as the real host would, then post the response
 * back on the same channel shape (`crewcode:response`).
 */
function handlePluginMessage(
  data: unknown,
  context: { worker: WorkerLike; permissions: string[]; workspaceRoot: string; calls: PluginCapabilityCall[]; runtimeErrors: PluginRuntimeError[] }
): void {
  if (!data || typeof data !== "object") return;
  const message = data as Record<string, unknown>;

  if (message.type === "crewcode:runtimeError") {
    context.runtimeErrors.push({ phase: "plugin", message: String(message.message ?? "plugin runtime error"), stack: typeof message.stack === "string" ? message.stack : undefined });
    return;
  }
  if (message.type !== "crewcode:request" || typeof message.id !== "string" || typeof message.method !== "string") return;

  const params = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? (message.params as Record<string, unknown>) : undefined;
  const result: PluginInvokeResult = invokePluginCapability({ method: message.method, params, permissions: context.permissions, workspaceRoot: context.workspaceRoot });

  const required = isPluginInvokeMethod(message.method) ? METHOD_PERMISSIONS[message.method] : undefined;
  const missingPermission = !result.ok && required && !context.permissions.includes(required) ? required : undefined;

  context.calls.push({
    method: message.method,
    ...(params ? { params } : {}),
    ok: result.ok,
    ...(result.ok ? {} : { error: result.error }),
    ...(missingPermission ? { missingPermission } : {})
  });

  context.worker.postMessage({ kind: "frame-message", data: { type: "crewcode:response", id: message.id, ...result } });
}

function buildEntryFindings(input: {
  entry: PluginEntryRef;
  loaded: boolean;
  calls: PluginCapabilityCall[];
  runtimeErrors: PluginRuntimeError[];
  interactions: Array<{ target: string; dispatched: boolean }>;
  permissions: string[];
}): PluginTestFinding[] {
  const findings: PluginTestFinding[] = [];

  if (!input.loaded) {
    findings.push({ severity: "error", code: "load-failed", message: `${input.entry.entry} did not finish loading inside the sandbox.` });
  }
  for (const error of input.runtimeErrors) {
    // A browser API this stub DOM does not implement is a limitation of the
    // harness, not a defect in the plugin. Reporting it as an error would fail
    // perfectly healthy plugins and train people to ignore the tool.
    const missingApi = missingBrowserApi(error.message);
    if (missingApi) {
      findings.push({
        severity: "warning",
        code: "unsupported-dom-api",
        message: `${input.entry.entry} uses "${missingApi}", which this stub DOM does not implement. This is a limit of the smoke harness, not a plugin defect — the code past this point was not exercised.`
      });
      continue;
    }
    // A framework that mounts into a real DOM node (React/Vue/Svelte) cannot run
    // against a stub. Saying "failed" here would be a lie about the plugin.
    if (isFrameworkMountFailure(error.message)) {
      findings.push({
        severity: "warning",
        code: "framework-panel-unsupported",
        message: `${input.entry.entry} renders through a DOM framework that requires a real browser DOM, so this harness could only verify that its scripts load. Contract coverage for this panel is limited to load time; run it in CrewCode to exercise the UI.`
      });
      continue;
    }
    findings.push({ severity: "error", code: "runtime-error", message: `${error.phase}: ${error.message}` });
  }

  // The highest-value output: a permission mismatch that static validation cannot
  // see, because the call only exists at runtime.
  const missing = new Map<string, string>();
  for (const call of input.calls) {
    if (call.missingPermission) missing.set(call.method, call.missingPermission);
  }
  for (const [method, permission] of missing) {
    findings.push({
      severity: "error",
      code: "missing-permission",
      message: `The plugin calls ${method} at runtime but its manifest does not declare "${permission}". The real host denies this call.`
    });
  }

  for (const call of input.calls) {
    if (call.ok || call.missingPermission) continue;
    if (isPluginInvokeMethod(call.method) && isAlwaysDeniedMethod(call.method)) {
      findings.push({
        severity: "warning",
        code: "reserved-method",
        message: `The plugin calls ${call.method}, which API v0 denies for every plugin regardless of declared permissions. It will always fail in CrewCode.`
      });
      continue;
    }
    if (!isPluginInvokeMethod(call.method)) {
      findings.push({ severity: "error", code: "unsupported-method", message: `The plugin calls "${call.method}", which is not a v0 capability method.` });
      continue;
    }
    findings.push({ severity: "warning", code: "call-failed", message: `${call.method} failed against the smoke workspace: ${call.error}` });
  }

  const declaredButUnused = input.permissions.filter((permission) => ["workspace:read", "workspace:write"].includes(permission) && !input.calls.some((call) => METHOD_PERMISSIONS[call.method as never] === permission));
  for (const permission of declaredButUnused) {
    findings.push({ severity: "info", code: "unused-permission", message: `The manifest declares "${permission}" but no call needing it was made during this run. It may be unnecessary, or only reachable through an interaction the smoke script did not perform.` });
  }

  if (!input.interactions.length) {
    findings.push({ severity: "info", code: "no-controls", message: "The panel bound no click handlers, so only load and context handling were exercised." });
  }

  return findings;
}

/**
 * Recover the executable scripts from a panel entry, in document order: inline
 * `<script>` bodies and local `<script src>` files. Remote and module-type
 * scripts are skipped — the real host loads panels from a local protocol and a
 * remote script would not be reachable in the sandbox anyway.
 */
export function extractScripts(entryPath: string, pluginDir: string): PluginScript[] {
  const html = fs.readFileSync(entryPath, "utf8");
  const scripts: PluginScript[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

  for (const match of html.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const inline = match[2] ?? "";
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];

    if (!src) {
      if (inline.trim()) scripts.push({ name: `${path.basename(entryPath)}#inline-${scripts.length + 1}`, code: inline });
      continue;
    }
    if (/^[a-z]+:\/\//i.test(src) || src.startsWith("//")) continue;

    const resolved = path.resolve(path.dirname(entryPath), src);
    if (!resolved.startsWith(path.resolve(pluginDir) + path.sep)) {
      throw new Error(`script src escapes the plugin folder: ${src}`);
    }
    if (!fs.existsSync(resolved)) throw new Error(`script src does not exist: ${src}`);
    scripts.push({ name: path.relative(pluginDir, resolved), code: fs.readFileSync(resolved, "utf8") });
  }
  return scripts;
}

/**
 * Browser surface the stub DOM does not implement. Kept as an explicit list so a
 * genuine plugin bug is never laundered into a "harness limitation" — only these
 * named APIs get the benefit of the doubt.
 */
const KNOWN_UNSTUBBED_APIS = [
  "IntersectionObserver", "MutationObserver", "ResizeObserver", "PerformanceObserver",
  "customElements", "ShadowRoot", "attachShadow", "IndexedDB", "indexedDB",
  "WebSocket", "Worker", "SharedWorker", "ServiceWorker", "navigator.serviceWorker",
  "requestAnimationFrame", "OffscreenCanvas", "HTMLCanvasElement", "getContext",
  "CSS", "CSSStyleSheet", "FontFace", "matchMedia", "IntlDisplayNames",
  "clipboard", "showOpenFilePicker", "showSaveFilePicker", "ResizeObserverEntry"
];

/** Returns the unimplemented browser API a runtime error blames, if any. */
export function missingBrowserApi(message: string): string | undefined {
  const referenceError = /(\w[\w.]*) is not defined/.exec(message)?.[1];
  if (referenceError && KNOWN_UNSTUBBED_APIS.some((api) => api === referenceError || api.endsWith(`.${referenceError}`))) return referenceError;

  // `Cannot read properties of undefined (reading 'writeText')` — the property
  // name is what identifies the missing surface here.
  const propertyRead = /reading '([^']+)'/.exec(message)?.[1];
  if (propertyRead && KNOWN_UNSTUBBED_APIS.some((api) => api === propertyRead || api.endsWith(`.${propertyRead}`))) return propertyRead;

  const notAFunction = /(\w[\w.]*) is not a function/.exec(message)?.[1];
  if (notAFunction) {
    const tail = notAFunction.split(".").pop() ?? notAFunction;
    if (KNOWN_UNSTUBBED_APIS.some((api) => api === notAFunction || api === tail)) return notAFunction;
  }
  return undefined;
}

/**
 * Signatures of a UI framework refusing to mount into the stub DOM. Kept narrow
 * and specific: each entry means "the container is not a real DOM node", which is
 * unambiguously this harness's limitation and not the plugin's fault.
 */
const FRAMEWORK_MOUNT_SIGNATURES = [
  "Minified React error #299",
  "Minified React error #200",
  "Target container is not a DOM element",
  "createRoot(): Target container",
  "Cannot read properties of null (reading 'appendChild')",
  "container is not a DOM element",
  "Failed to mount"
];

export function isFrameworkMountFailure(message: string): boolean {
  return FRAMEWORK_MOUNT_SIGNATURES.some((signature) => message.includes(signature));
}

/** One element the sandbox knows about, used to find the real controls. */
export type SnapshotElement = { id: string; text?: string; html?: string; listeners?: string[] };

/**
 * Ask the sandbox which elements exist and what they listen for. A snapshot that
 * never arrives is not fatal — it just means no controls get exercised, which is
 * reported rather than failing the run.
 */
async function requestSnapshot(worker: WorkerLike, pending: () => Promise<SnapshotElement[]>, timeoutMs: number): Promise<SnapshotElement[]> {
  const waiting = pending();
  worker.postMessage({ kind: "snapshot", requestId: "snapshot-1" });
  try {
    return await withTimeout(waiting, Math.min(timeoutMs, 2000), "sandbox did not return a DOM snapshot");
  } catch {
    return [];
  }
}

function collectEntries(manifest: Record<string, unknown>): PluginEntryRef[] {
  const contributes = (manifest.contributes ?? {}) as Record<string, unknown>;
  const entries: PluginEntryRef[] = [];
  for (const contribution of ["tabs", "sidebarPanels"]) {
    const list = contributes[contribution];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.entry !== "string") continue;
      entries.push({
        contribution,
        id: typeof record.id === "string" ? record.id : "unknown",
        title: typeof record.title === "string" ? record.title : "",
        entry: record.entry
      });
    }
  }
  // One panel commonly backs both a tab and a sidebar panel; run each file once.
  const seen = new Set<string>();
  return entries.filter((entry) => (seen.has(entry.entry) ? false : seen.add(entry.entry) && true));
}

function readManifest(pluginDir: string): Record<string, unknown> {
  const manifestPath = path.join(pluginDir, "crewcode.plugin.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing crewcode.plugin.json in ${pluginDir}`);
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest is not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`crewcode.plugin.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const defaultCreateWorker = (source: string, workerData: Record<string, unknown>): WorkerLike =>
  // Empty env: untrusted plugin code must not be able to read the operator's
  // API keys out of process.env just because it was handed a Node worker.
  new Worker(source, { eval: true, workerData, env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 } });

/** Let queued microtasks and timers run so plugin promise chains can complete. */
function settle(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message} (timed out after ${ms}ms)`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
