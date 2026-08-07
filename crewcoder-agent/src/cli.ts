#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { readConfig, setConfigValue, writeConfig, type ModelPriceEntry } from "./core/config.js";
import { ensureCrewCoderHome } from "./core/crewcoder-home.js";
import { discoverCrewCodeRepo } from "./core/crewcode-repo.js";
import { isAgentMode, AGENT_MODE_LIST } from "./core/mode-router.js";
import type { AgentMode, PluginKind } from "./core/types.js";
import { runAgentLoop } from "./core/agent-loop.js";
import { runAgentLoopContinue } from "./core/agent-loop-continue.js";
import { createJsonEventSink } from "./core/json-event-stream.js";
import { loadSession } from "./core/session-loader.js";
import { branchSession } from "./core/session-branch.js";
import { whenSessionWritesSettle } from "./core/session-store.js";
import { prepareLiveCompaction, applyCompactionProposal } from "./core/session-compaction.js";
import { renderSessionHtml } from "./core/session-export.js";
import { attachStdinControlListener, type CompactionPreviewDecision } from "./core/stdin-control.js";
import { runAcpStdioServer } from "./acp/acp-server.js";
import { createExtensionUiBridge } from "./core/extension-ui-bridge.js";
import { createPlugin, isSupportedPluginKind } from "./generators/plugin-generator.js";
import { listTemplates, supportedPluginKinds } from "./generators/template-registry.js";
import { createCrewCoderExtension } from "./generators/extension-generator.js";
import { validatePlugin } from "./tools/validate-plugin.js";
import { runPluginTest, type PluginTestFinding, type PluginTestReport } from "./core/plugin-test-runner.js";
import { loadFilesystemSkills, findFilesystemSkill, resolveSkillsDir } from "./skills/filesystem/loader.js";
import { queryCrewCodeDocs } from "./knowledge/crewcode-docs.js";
import { queryCrewCoderExtensionDocs } from "./knowledge/crewcoder-extension-docs.js";
import { listProviders } from "./providers/provider-registry.js";
import { resolveProviderTransport } from "./providers/provider-transport.js";
import { ProviderModelClient } from "./providers/provider-model-client.js";
import { createModelClientFromEnv } from "./core/model-client.js";
import { listProviderModelIds } from "./providers/model-resolution.js";
import { resolveModel } from "./providers/model-registry.js";
import { loginCodexDeviceCode } from "./providers/oauth-codex.js";
import { closeCodexWebSocketSessions } from "./providers/codex-websocket-transport.js";
import { removeAuthCredential, setAuthCredential, readAuthFile, getAuthPath } from "./providers/auth-store.js";
import { getActiveWorker, listWorkers, createWorker, deleteWorker, setActiveWorker, setWorkerIdentityValue, getWorkerIdentityMdPath, type IdentitySetKey } from "./core/identity.js";
import { loadCrewCoderExtensions } from "./extensions/extension-loader.js";
import { inspectExtension, setExtensionEnabled, setExtensionTrusted, setExtensionTrustTier, getExtensionTrustTier, validateExtensionPath } from "./extensions/extension-registry.js";
import { installExtension, uninstallExtension, updateExtension, formatCapabilitySummary, type ExtensionInstallResult } from "./extensions/extension-install.js";
import { DEFAULT_EXTENSION_REGISTRY, addRegistry, clearRegistryCache, loadRegistries, removeRegistry, searchRegistries } from "./extensions/extension-registry-index.js";
import { listWorkflows, findWorkflow, describeWorkflow, runWorkflow } from "./extensions/extension-workflows.js";
import { isTrustTier, type TrustTier } from "./core/trust.js";
import { saveSession, type SessionRecord } from "./core/session-store.js";
import { listSessionSummaries } from "./core/session-admin.js";
import { formatPruneBytes, planSessionPrune } from "./core/session-prune.js";
import { addSessionExternalDirectory, removeSessionExternalDirectory, setSessionExternalDirectories, validateExternalDirectories } from "./core/external-directories.js";
import { listSessionCheckpoints, previewSessionCheckpointRestore, restoreSessionCheckpoint } from "./core/session-checkpoints.js";
import type { ApprovalMode } from "./core/approval.js";
import { createBackendDebugLogger } from "./core/backend-debug-logger.js";
import { openUrlInDefaultBrowser } from "./core/browser-opener.js";
import type { AgentEventSink } from "./core/events.js";
import { runCrewTaskCommand } from "./crew-tasks/cli.js";
import { getSystemPrompt, listSystemPrompts, resolveSystemPromptsDir, saveSystemPrompt } from "./core/system-prompt-store.js";
import { resolvePromptCommandsDir, savePromptCommand } from "./core/prompt-command-store.js";
import { getAvailablePromptCommand, listAvailablePromptCommands, parsePromptCommandArgs, runAvailablePromptCommand } from "./extensions/extension-commands.js";
import { listTrustedExtensionRenderers } from "./extensions/extension-renderers.js";
import { listLiveUiContributions } from "./extensions/extension-live-ui.js";
import { loadTrustedExtensionApprovalPolicies } from "./extensions/extension-approval-policies.js";
import { loadTrustedExtensionHooks, runCompactionHooks } from "./extensions/extension-hooks.js";
import { createGitWorkflowHelpers } from "./core/git-workflow.js";
import { getAuditLogPath, readAuditLog } from "./core/audit-log.js";
import { getCostLedgerPath, readCostLedger, recordModelUsageCost, startOfToday, summarizeCosts, type CostGroupBy, type CostTotals } from "./core/cost-ledger.js";
import { diffModels, parseModelSpecs, type ModelDiffReport } from "./core/model-diff.js";
import { formatUsd } from "./core/model-pricing.js";
import { handoffToWorker, parseWorkerList, runWorkerCrew } from "./core/worker-crews.js";
import { buildTeamPrompt, loadWorkerTeams, resolveWorkerTeam, teamWorkerNames } from "./core/worker-teams.js";
import { startFleetServer } from "./core/fleet-server.js";
import { createFleetDeployPlan, executeFleetDeployPlan } from "./core/fleet-deploy.js";
import { getFleetTokenPath, getOrCreateFleetToken, rotateFleetToken } from "./core/fleet-auth.js";
import { parseTokenBudget } from "./core/token-budget.js";
import { forgetMemory, isProjectMemoryEnabled, listMemories, readMemoryContext, rememberFact, resolveMemoryDir, resolveMemorySettingsPath, setProjectMemoryEnabled } from "./core/memory-store.js";
import { formatSessionSinceContext, summarizeSessionsSince } from "./core/session-since.js";
import { explainLastDecision, formatDecisionEvidence } from "./core/session-why.js";
import { searchSessions } from "./core/session-search.js";
import { replaySessionTurn } from "./core/reproducible-run.js";
import { createCiErrorSummary, createCiRunSummary } from "./core/ci-run.js";
import { installPreCommitHook } from "./core/git-hooks.js";
import { clearGoal, decideGoalApproval, pauseGoal, refreshGoal, resumeGoal, runGoalWorker, startGoal } from "./core/goal-runner.js";
import { goalEventsPath, goalStderrPath, goalStdoutPath, listGoals, type GoalRecord } from "./core/goal-store.js";
import { isStandaloneExecutable } from "./core/self-invocation.js";
import { CREWCODER_VERSION } from "./core/version.js";
import { detectCrewCodeProject, isIntegrationProfile, resolveIntegrationProfile, setCrewCodeProfilePromptDismissed, setProjectIntegrationProfile } from "./core/integration-profile.js";

/**
 * Flush durable state before dying on a termination signal.
 *
 * The TUI stops a run with SIGTERM and Ctrl+C sends SIGINT. Without a handler,
 * Node exits immediately, which can truncate a `session.jsonl` append mid-line and
 * make the whole session unreadable. Draining in-flight writes first bounds that
 * to a few milliseconds; the exit code still reports that we were signalled.
 *
 * Deliberately does not try to finish the current model turn — a stop must stop.
 */
function installSignalFlush(): void {
  let terminating = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      // A second signal is the user insisting. Honor it immediately.
      if (terminating) process.exit(130);
      terminating = true;
      void whenSessionWritesSettle().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
}

installSignalFlush();

const program = new Command();
program.name("crewcoder").description("CrewCoder: Coding agent CLI with built-in providers, extensions, sessions, approvals, and JSON events.").version(CREWCODER_VERSION);

type RunOptions = { mode?: string; provider?: string; model?: string; effort?: string; maxIterations?: string; heuristic?: boolean; jsonEvents?: boolean; ci?: boolean; approval?: string; backendDebugStderr?: boolean; dumpModelInput?: boolean; systemPrompt?: string; worker?: string; budget?: string; maxTokens?: string; verify?: boolean; parentSession?: string; replay?: string; at?: string; image?: string[]; addDir?: string[] };
type GoalOptions = Pick<RunOptions, "mode" | "provider" | "model" | "effort" | "approval" | "systemPrompt" | "worker" | "budget" | "maxTokens"> & { json?: boolean; maxTurns?: string; checkModel?: string | false; timeoutMinutes?: string };

// Collector for repeatable --image flags: `--image a.png --image b.png`.
function collectImagePath(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function collectDirectoryPath(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

program.command("run", { isDefault: true })
  .argument("[prompt...]")
  .option("-m, --mode <mode>", "general, plugin, extension")
  .option("-p, --provider <provider>", "Provider id (see: crewcoder providers)")
  .option("--model <model>", "Provider model")
  .option("--effort <level>", "Reasoning effort: none, low, medium, high, xhigh")
  .option("--max-iterations <number>", "Maximum iterations")
  .option("--budget <tokens>", "Durable session token budget, e.g. 200k")
  .option("--max-tokens <tokens>", "Alias for --budget")
  .option("--verify", "Run typecheck, tests, and trusted extension validators after the agent")
  .option("--ci", "Emit one JSON summary on stdout, run verification, and use structured CI exit codes")
  .option("--parent-session <id>", "Link a fresh summary-handoff session to its source session")
  .option("--replay <sessionId>", "Replay an exact stored model input from a prior session")
  .option("--at <turn>", "1-indexed model turn to replay; requires --replay")
  .option("--approval <mode>", "never, review, always, full-access, sandboxed", "never")
  .option("--json-events", "Emit newline-delimited JSON events for TUI consumption")
  .option("--backend-debug-stderr", "Also stream backend debug events to stderr")
  .option("--dump-model-input", "Write exact model input payloads to ~/.crewcoder/logs for debugging")
  .option("--system-prompt <name>", "Use a stored custom system prompt for this run")
  .option("--worker <name>", "Use a specific worker identity for this run only (does not change the active worker)")
  .option("--add-dir <path>", "Grant an external directory to this session (repeatable)", collectDirectoryPath, [])
  .option("--image <path>", "Attach an image file for vision-capable providers (repeatable)", collectImagePath, [])
  .option("--heuristic", "Use starter heuristic instead of provider")
  .action(async (promptParts: string[] | undefined, options: RunOptions) => runPrompt(promptParts?.join(" ") ?? "", options));

const profile = program.command("profile").description("Select standalone or CrewCode-integrated behavior.");
profile.command("show", { isDefault: true }).description("Show the effective integration profile.").action(() => {
  const config = readConfig();
  console.log(resolveIntegrationProfile(process.cwd(), config));
});
profile.command("detect").option("--json", "Output raw JSON").description("Detect high-confidence CrewCode project markers.").action((options: { json?: boolean }) => {
  const detection = detectCrewCodeProject(process.cwd());
  if (options.json) { console.log(JSON.stringify(detection, null, 2)); return; }
  console.log(detection.detected ? `CrewCode project markers: ${detection.markers.join(", ")}` : "No CrewCode project markers detected.");
});
profile.command("dismiss").description("Dismiss the CrewCode profile suggestion for this project.").action(() => {
  console.log(`CrewCode profile suggestion dismissed for this project.`);
  console.log(setCrewCodeProfilePromptDismissed(process.cwd()));
});
profile.command("use").argument("<profile>", "standalone or crewcode").option("--project", "Save in this repository's crewcoder.json").description("Select an integration profile.").action((value: string, options: { project?: boolean }) => {
  if (!isIntegrationProfile(value)) throw new Error("Profile must be one of: standalone, crewcode");
  if (options.project) {
    console.log(`Project integration profile set to ${value}.`);
    console.log(setProjectIntegrationProfile(process.cwd(), value));
  } else {
    setConfigValue("integrationProfile", value);
    console.log(`User integration profile set to ${value}.`);
  }
});

const crew = program.command("crew").description("Run and hand off work across named CrewCoder workers.");
crew.command("run")
  .argument("<prompt...>")
  .requiredOption("--workers <names>", "Comma-separated worker names, e.g. reviewer,builder")
  .option("-m, --mode <mode>", "general, plugin, extension")
  .option("-p, --provider <provider>", "codex, claude, opencode, or extension provider")
  .option("--model <model>", "Provider model")
  .option("--effort <level>", "Reasoning effort: none, low, medium, high, xhigh")
  .option("--max-iterations <number>", "Maximum iterations")
  .option("--approval <mode>", "never, review, always, full-access, sandboxed", "never")
  .option("--json", "Output a JSON crew summary")
  .option("--json-events", "Emit newline-delimited JSON events from each worker run")
  .option("--backend-debug-stderr", "Also stream backend debug events to stderr")
  .option("--dump-model-input", "Write exact model input payloads to ~/.crewcoder/logs for debugging")
  .option("--system-prompt <name>", "Use a stored custom system prompt for each worker run")
  .option("--heuristic", "Use starter heuristic instead of provider")
  .action(async (promptParts: string[], options: RunOptions & { workers: string; json?: boolean }) => runCrewPrompt(promptParts.join(" "), options));
crew.command("handoff")
  .argument("<workerRef>", "Target worker reference, e.g. worker:reviewer")
  .argument("<sessionId>", "Source session id")
  .argument("[prompt...]")
  .option("-m, --mode <mode>", "general, plugin, extension")
  .option("-p, --provider <provider>", "codex, claude, opencode, or extension provider")
  .option("--model <model>", "Provider model")
  .option("--effort <level>", "Reasoning effort: none, low, medium, high, xhigh")
  .option("--max-iterations <number>", "Maximum iterations")
  .option("--approval <mode>", "never, review, always, full-access, sandboxed", "never")
  .option("--json", "Output a JSON handoff summary")
  .option("--json-events", "Emit newline-delimited JSON events for the handoff run")
  .option("--backend-debug-stderr", "Also stream backend debug events to stderr")
  .option("--dump-model-input", "Write exact model input payloads to ~/.crewcoder/logs for debugging")
  .option("--system-prompt <name>", "Use a stored custom system prompt for this handoff run")
  .option("--heuristic", "Use starter heuristic instead of provider")
  .action(async (workerRef: string, sessionId: string, promptParts: string[], options: RunOptions & { json?: boolean }) => runCrewHandoff(workerRef, sessionId, promptParts.join(" "), options));
const crewTeam = crew.command("team").description("Run worker teams declared in ./crewcoder.json.");
crewTeam.command("list", { isDefault: true }).option("--json", "Output raw JSON").description("List worker teams declared in ./crewcoder.json.").action((options: { json?: boolean }) => {
  const manifest = loadWorkerTeams(process.cwd());
  const teams = manifest?.teams ?? [];
  if (options.json) { console.log(JSON.stringify({ path: manifest?.path ?? null, teams }, null, 2)); return; }
  if (!manifest) { console.log(pc.yellow("No crewcoder.json found in this workspace.")); return; }
  if (!teams.length) { console.log(pc.yellow(`No worker teams declared in ${manifest.path}.`)); return; }
  for (const team of teams) {
    console.log(`${pc.cyan(team.id)} - ${team.description ?? "worker team"}`);
    console.log(pc.gray(`  workers: ${teamWorkerNames(team).join(", ")}`));
  }
});
crewTeam.command("run")
  .argument("<teamId>")
  .argument("<prompt...>")
  .option("-m, --mode <mode>", "general, plugin, extension")
  .option("-p, --provider <provider>", "codex, claude, opencode, or extension provider")
  .option("--model <model>", "Provider model")
  .option("--effort <level>", "Reasoning effort: none, low, medium, high, xhigh")
  .option("--max-iterations <number>", "Maximum iterations")
  .option("--approval <mode>", "never, review, always, full-access, sandboxed", "never")
  .option("--json", "Output a JSON crew summary")
  .option("--json-events", "Emit newline-delimited JSON events from each worker run")
  .option("--backend-debug-stderr", "Also stream backend debug events to stderr")
  .option("--dump-model-input", "Write exact model input payloads to ~/.crewcoder/logs for debugging")
  .option("--system-prompt <name>", "Use a stored custom system prompt for each worker run")
  .option("--heuristic", "Use starter heuristic instead of provider")
  .description("Run a declared worker team.")
  .action(async (teamId: string, promptParts: string[], options: RunOptions & { json?: boolean }) => runCrewTeam(teamId, promptParts.join(" "), options));

const fleet = program.command("fleet").description("Manage authenticated fleet runner access.");
fleet.command("token")
  .option("--path", "Print the fleet token file path instead of the token")
  .option("--rotate", "Replace the fleet token and invalidate existing fleet clients")
  .description("Print or rotate the persistent fleet bearer token.")
  .action((options: { path?: boolean; rotate?: boolean }) => {
    if (options.path) {
      if (options.rotate) throw new Error("--path and --rotate cannot be combined.");
      getOrCreateFleetToken();
      console.log(getFleetTokenPath());
      return;
    }
    if (options.rotate) {
      console.log(rotateFleetToken());
      console.error(pc.yellow("Fleet token rotated. Restart the fleet server to activate it."));
      return;
    }
    console.log(getOrCreateFleetToken());
  });

program.command("serve")
  .option("--host <host>", "Host/interface to bind", "127.0.0.1")
  .option("--port <port>", "Port to bind", "8787")
  .description("Start a headless HTTP/WebSocket server speaking CrewCoder's JSON event protocol.")
  .action(async (options: { host: string; port: string }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
    const server = await startFleetServer({ host: options.host, port, cwd: process.cwd() });
    console.log(pc.green(`CrewCoder fleet server listening at ${server.url}`));
    console.log(pc.gray(`Bearer authentication required. Token file: ${getFleetTokenPath()}`));
    console.log(pc.gray("POST /runs, GET /runs/:id/events, WS /runs/:id/ws"));
  });

program.command("acp")
  .option("--approval <mode>", "never, review, always, full-access, sandboxed", "review")
  .option("--mode <mode>", AGENT_MODE_LIST)
  .description("Run CrewCoder as an Agent Client Protocol agent over JSON-RPC on stdio.")
  .action(async (options: { approval: string; mode?: string }) => {
    await runAcpStdioServer({
      approvalMode: normalizeApprovalMode(options.approval),
      mode: options.mode ? normalizeMode(options.mode) : undefined
    });
  });

program.command("deploy")
  .argument("<target>", "SSH target, e.g. user@host")
  .option("--remote-dir <dir>", "Remote install directory", "~/crewcoder-runner")
  .option("--host <host>", "Remote serve host", "127.0.0.1")
  .option("--port <port>", "Remote serve port", "8787")
  .option("--binary <path>", "Upload a standalone Linux x64 executable instead of installing through npm")
  .option("--execute", "Execute the SSH/SCP deployment plan. Without this, print the plan only.")
  .description("Ship a CrewCoder runner to a VPS/sandbox and start crewcoder serve.")
  .action(async (target: string, options: { remoteDir: string; host: string; port: string; binary?: string; execute?: boolean }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
    const plan = createFleetDeployPlan(target, {
      remoteDir: options.remoteDir,
      host: options.host,
      port,
      binaryPath: options.binary ? path.resolve(options.binary) : undefined
    });
    if (!options.execute) {
      console.log(pc.cyan("CrewCoder deploy plan (dry run):"));
      for (const command of plan.commands) console.log(`  ${command}`);
      console.log(pc.gray(`After startup, retrieve the bearer token with: ssh ${plan.target} 'cat ${plan.tokenPath}'`));
      console.log(pc.gray("Re-run with --execute to run these commands."));
      return;
    }
    await executeFleetDeployPlan(plan, process.cwd());
    console.log(pc.green(`Deployed CrewCoder runner to ${plan.target}.`));
    console.log(pc.gray(`Retrieve the bearer token with: ssh ${plan.target} 'cat ${plan.tokenPath}'`));
  });

program.command("search").argument("<query...>").option("--json", "Output structured matches").description("Search all durable session messages and prompt/response hash IDs.").action(async (queryParts: string[], options: { json?: boolean }) => {
  const matches = await searchSessions(queryParts.join(" "));
  if (options.json) { console.log(JSON.stringify(matches, null, 2)); return; }
  if (!matches.length) { console.log(pc.yellow("No session history matched.")); return; }
  for (const match of matches) {
    console.log(`${pc.cyan(match.sessionId)} ${pc.gray(`message ${match.messageIndex + 1} · ${match.role}`)}${match.messageId ? ` ${pc.magenta(match.messageId)}` : ""}`);
    console.log(`  ${match.snippet}`);
  }
});

const goalCommand = program.command("goal").description("Run and manage durable detached goals.");
goalCommand.command("start")
  .argument("<objective...>")
  .option("-m, --mode <mode>", "general, plugin, extension")
  .option("-p, --provider <provider>", "Provider id")
  .option("--model <model>", "Provider model")
  .option("--effort <level>", "Reasoning effort: none, low, medium, high, xhigh")
  .option("--approval <mode>", "never, review, always, full-access, sandboxed", "review")
  .option("--budget <tokens>", "Durable goal token budget")
  .option("--max-tokens <tokens>", "Alias for --budget")
  .option("--max-turns <number>", "Maximum goal supervisor cycles before pausing")
  .option("--check-model <model>", "Independent verifier model on the goal provider")
  .option("--no-check-model", "Disable the verifier for this goal")
  .option("--timeout-minutes <number>", "Wall-clock goal timeout")
  .option("--system-prompt <name>", "Use a stored custom system prompt")
  .option("--worker <name>", "Use a specific worker identity")
  .option("--json", "Output the goal record as JSON")
  .description("Start a provider-independent goal in a detached worker.")
  .action(async (objective: string[], options: GoalOptions) => {
    const config = readConfig();
    const provider = options.provider ?? process.env.CREWCODER_PROVIDER ?? config.defaultProvider;
    const model = options.model ?? process.env.CREWCODER_MODEL ?? config.defaultModel;
    if (!model) throw new Error("A concrete model is required to start a goal.");
    const effort = normalizeEffortOption(options.effort);
    const tokenBudget = resolveTokenBudget(options);
    const maxTurns = parseGoalIntegerOption(options.maxTurns, config.goals.maxTurns, "--max-turns", 10_000);
    const timeoutMinutes = parseGoalIntegerOption(options.timeoutMinutes, config.goals.timeoutMinutes, "--timeout-minutes", 43_200);
    const checkModel = options.checkModel === false
      ? undefined
      : (typeof options.checkModel === "string" ? options.checkModel.trim() : "") || config.goals.checkModel;
    const record = await startGoal({
      objective: objective.join(" "),
      cwd: process.cwd(),
      provider,
      model,
      mode: normalizeMode(options.mode ?? config.defaultMode),
      approvalMode: normalizeApprovalMode(options.approval ?? "review"),
      maxTurns,
      timeoutMinutes,
      ...(checkModel ? { checkModel } : {}),
      ...(effort ? { effort } : {}),
      ...(tokenBudget ? { tokenBudget } : {}),
      ...(options.systemPrompt ? { systemPromptName: options.systemPrompt } : {}),
      ...(options.worker ? { workerName: options.worker } : {})
    });
    printGoal(record, options.json);
  });
goalCommand.command("status", { isDefault: true }).argument("[id]").option("--json", "Output raw JSON").action(async (id: string | undefined, options: { json?: boolean }) => {
  try { printGoal(await refreshGoal(id), options.json); }
  catch (error) {
    if (options.json && error instanceof Error && error.message.includes("No goal found")) { console.log("null"); return; }
    throw error;
  }
});
goalCommand.command("list").option("--json", "Output raw JSON").action(async (options: { json?: boolean }) => {
  const goals = await listGoals(process.cwd());
  if (options.json) { console.log(JSON.stringify(goals, null, 2)); return; }
  if (!goals.length) { console.log(pc.yellow("No goals found in this workspace.")); return; }
  for (const goal of goals) printGoal(goal, false);
});
goalCommand.command("pause").argument("[id]").option("--json", "Output raw JSON").action(async (id: string | undefined, options: { json?: boolean }) => printGoal(await pauseGoal(id), options.json));
goalCommand.command("resume").argument("[id]").option("--approval <mode>", "never, review, always, full-access, sandboxed").option("--json", "Output raw JSON").action(async (id: string | undefined, options: { approval?: string; json?: boolean }) => {
  printGoal(await resumeGoal(id, { approvalMode: options.approval ? normalizeApprovalMode(options.approval) : undefined }), options.json);
});
goalCommand.command("clear").argument("[id]").option("--json", "Output raw JSON").action(async (id: string | undefined, options: { json?: boolean }) => printGoal(await clearGoal(id), options.json));
goalCommand.command("approve").argument("[id]").option("--reason <text>").option("--json", "Output raw JSON").action(async (id: string | undefined, options: { reason?: string; json?: boolean }) => {
  printGoal(await decideGoalApproval(id, true, { reason: options.reason }), options.json);
});
goalCommand.command("deny").argument("[id]").option("--reason <text>").option("--json", "Output raw JSON").action(async (id: string | undefined, options: { reason?: string; json?: boolean }) => {
  printGoal(await decideGoalApproval(id, false, { reason: options.reason }), options.json);
});
goalCommand.command("logs").argument("[id]").option("--stderr", "Show worker stderr instead of events").option("--worker", "Show the worker stdout log instead of events").action(async (id: string | undefined, options: { stderr?: boolean; worker?: boolean }) => {
  const goal = await refreshGoal(id);
  const file = options.stderr ? goalStderrPath(goal.id) : options.worker ? goalStdoutPath(goal.id) : goalEventsPath(goal.id);
  console.log(fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd() : "");
});
goalCommand.command("worker", { hidden: true }).argument("<id>").action(async (id: string) => {
  const result = await runGoalWorker(id);
  if (result.status === "failed") process.exitCode = 1;
});

const session = program.command("session").description("Session commands for resume, branch, and TUI backends.");
session.command("list").option("--json", "Output raw JSON").action(async (options: { json?: boolean }) => printSessions(options.json));
session.command("show").argument("<id>").action(async (id: string) => console.log(JSON.stringify(await loadSession(id), null, 2)));
session.command("prune")
  .description("Report or reclaim disk used by the session store. Dry run unless --apply.")
  .option("--artifacts", "Leftover files in session directories (default when no category is given)")
  .option("--checkpoints", "Checkpoint snapshots for sessions older than --older-than")
  .option("--sessions", "Whole session directories older than --older-than")
  .option("--older-than <days>", "Age threshold; required for --checkpoints and --sessions")
  .option("--keep <id>", "Session id to leave untouched (repeatable)", collectDirectoryPath, [])
  .option("--apply", "Actually delete. Without this the command only reports.")
  .option("--json", "Output raw JSON")
  .action(async (options: { artifacts?: boolean; checkpoints?: boolean; sessions?: boolean; olderThan?: string; keep?: string[]; apply?: boolean; json?: boolean }) => {
    const olderThanDays = options.olderThan === undefined ? undefined : Number(options.olderThan);
    if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays <= 0)) {
      console.error(pc.red("--older-than must be a positive number of days."));
      process.exitCode = 1;
      return;
    }
    const plan = await planSessionPrune({
      artifacts: options.artifacts,
      checkpoints: options.checkpoints,
      sessions: options.sessions,
      olderThanDays,
      keep: options.keep,
      apply: options.apply
    });
    if (options.json) { console.log(JSON.stringify(plan, null, 2)); if (plan.failures.length) process.exitCode = 1; return; }

    if (!plan.targets.length && !plan.failures.length) {
      console.log(pc.green(`Nothing to prune (${plan.sessionsScanned} sessions scanned).`));
      return;
    }
    for (const target of plan.targets.slice(0, 20)) {
      console.log(`${pc.cyan(formatPruneBytes(target.bytes).padStart(9))}  ${pc.gray(target.kind.padEnd(11))} ${target.sessionId}`);
      console.log(`${" ".repeat(11)}${pc.gray(target.reason)}`);
    }
    if (plan.targets.length > 20) console.log(pc.gray(`  ... and ${plan.targets.length - 20} more`));
    const total = `${formatPruneBytes(plan.totalBytes)} across ${plan.targets.length} target${plan.targets.length === 1 ? "" : "s"}`;
    console.log(plan.applied ? pc.green(`\nReclaimed ${total}.`) : pc.yellow(`\nWould reclaim ${total}. Re-run with --apply to delete.`));
    for (const failure of plan.failures) console.log(pc.red(`  failed: ${failure.path} (${failure.error})`));
    if (plan.failures.length) process.exitCode = 1;
  });
session.command("resume").argument("<id>").argument("[prompt...]").option("--json-events", "Emit JSON events").option("-p, --provider <provider>").option("--model <model>").option("--effort <level>", "Reasoning effort: none, low, medium, high, xhigh").option("--mode <mode>", "auto, general, plugin", "auto").option("--budget <tokens>", "Set or replace the durable session token budget").option("--max-tokens <tokens>", "Alias for --budget").option("--verify", "Run verification checks after the agent").option("--approval <mode>", "never, review, always, full-access, sandboxed", "never").option("--backend-debug-stderr", "Also stream backend debug events to stderr").option("--dump-model-input", "Write exact model input payloads to ~/.crewcoder/logs for debugging").option("--system-prompt <name>", "Use a stored custom system prompt for this resumed run").option("--worker <name>", "Use a specific worker identity for this resumed run only").option("--add-dir <path>", "Grant an external directory to this session (repeatable)", collectDirectoryPath, []).option("--image <path>", "Attach an image file for vision-capable providers (repeatable)", collectImagePath, []).action(async (id: string, promptParts: string[], options: RunOptions) => {
  const config = readConfig();
  const record = await loadSession(id);
  const externalDirectories = await validateExternalDirectories(record.cwd, [...(record.externalDirectories ?? []), ...(options.addDir ?? [])]);
  const providerId = options.provider ?? process.env.CREWCODER_PROVIDER ?? record.provider ?? config.defaultProvider;
  const model = options.model ?? process.env.CREWCODER_MODEL ?? record.model ?? config.defaultModel;
  // No --effort and no env override means "keep resuming the way this session was
  // last run", matching the provider/model fallback above. A disabled
  // `thinkingEnabled` config still wins, because normalizeEffortOption returns
  // "none" outright in that case.
  const effort = normalizeEffortOption(options.effort) ?? record.effort;
  const jsonSink = options.jsonEvents ? createJsonEventSink() : undefined;
  const debug = createBackendDebugLogger({ emit: jsonSink, stderr: shouldDebugToStderr(options), runId: `resume-${id}-${Date.now()}` });
  await debug.event({ level: "info", source: "cli", message: "backend debug logger initialized", details: { logPath: debug.logPath, jsonEvents: Boolean(options.jsonEvents), stderr: shouldDebugToStderr(options) } });
  const manualCompactSignal = { requested: false, preview: false };
  const compactionPreviewSignal = { decisions: [] as CompactionPreviewDecision[] };
  const followUpSignal = { messages: [] as string[] };
  const approvalSignal = { decisions: [] as Array<{ approvalId: string; approved: boolean; reason?: string }> };
  const uiBridge = createExtensionUiBridge({ emit: jsonSink, hasUI: Boolean(options.jsonEvents) });
  const detachControl = options.jsonEvents ? attachStdinControlListener({
    onCompact: (opts) => { manualCompactSignal.requested = true; if (opts.preview) manualCompactSignal.preview = true; },
    onCompactPreviewDecision: (decision) => { compactionPreviewSignal.decisions.push(decision); },
    onFollowUp: (message) => { followUpSignal.messages.push(message); },
    onApprovalDecision: (decision) => { approvalSignal.decisions.push(decision); },
    onUiResponse: (response) => { uiBridge.resolveResponse(response.requestId, response.value); }
  }) : undefined;
  const contextWindow = (await resolveModel(providerId, model))?.metadata?.contextWindow;
  try {
    const result = await runAgentLoopContinue({ sessionId: id, prompt: promptParts?.join(" "), mode: normalizeMode(options.mode ?? readConfig().defaultMode), externalDirectories, images: options.image }, {
      providerId,
      model,
      effort,
      contextWindow,
      approvalMode: normalizeApprovalMode(options.approval ?? "never"),
      modelClient: options.heuristic ? undefined : new ProviderModelClient(providerId, process.cwd(), model, debug, effort),
      dumpModelInput: shouldDumpModelInput(options),
      systemPromptName: options.systemPrompt,
      workerName: options.worker,
      tokenBudget: resolveTokenBudget(options),
      verify: options.verify,
      manualCompactSignal,
      compactionPreviewSignal,
      followUpSignal,
      approvalSignal,
      uiBridge,
      emit: jsonSink
    });
    if (!options.jsonEvents) printRunResult(result, providerId, model);
    if (result.providerError || result.stallError || result.iterationCapReached) process.exitCode = 1;
  } finally {
    uiBridge.cancelAll();
    detachControl?.();
  }
});
session.command("branch").argument("<id>").action(async (id: string) => {
  const branched = await branchSession(id);
  console.log(pc.green(`Created branch session ${branched.id}`));
});
session.command("validate-dir").argument("<path>").option("--json", "Output raw JSON").description("Validate and canonicalize an external directory grant.").action(async (directory: string, options: { json?: boolean }) => {
  const [validated] = await validateExternalDirectories(process.cwd(), [directory]);
  if (!validated) throw new Error("The directory is already inside the primary workspace and does not need an external grant");
  if (options.json) { console.log(JSON.stringify({ path: validated })); return; }
  console.log(validated);
});
session.command("directories").argument("<id>").option("--json", "Output raw JSON").description("List external directories granted to a session.").action(async (id: string, options: { json?: boolean }) => {
  const record = await loadSession(id);
  const directories = record.externalDirectories ?? [];
  if (options.json) { console.log(JSON.stringify(directories, null, 2)); return; }
  if (!directories.length) { console.log(pc.yellow("No external directories attached.")); return; }
  for (const directory of directories) console.log(directory);
});
session.command("add-dir").argument("<id>").argument("<path>").option("--json", "Output raw JSON").description("Grant an external directory to a session.").action(async (id: string, directory: string, options: { json?: boolean }) => {
  const record = await addSessionExternalDirectory(id, directory);
  if (options.json) { console.log(JSON.stringify(record.externalDirectories ?? [], null, 2)); return; }
  console.log(pc.green(`Attached ${path.resolve(record.cwd, directory)} to ${id}.`));
});
session.command("remove-dir").argument("<id>").argument("[path]").option("--all", "Remove every external directory grant").option("--json", "Output raw JSON").description("Revoke an external directory from a session.").action(async (id: string, directory: string | undefined, options: { all?: boolean; json?: boolean }) => {
  if (!options.all && !directory) throw new Error("A path is required unless --all is used");
  const record = options.all ? await setSessionExternalDirectories(id, []) : await removeSessionExternalDirectory(id, directory!);
  if (options.json) { console.log(JSON.stringify(record.externalDirectories ?? [], null, 2)); return; }
  console.log(pc.green(options.all ? `Removed all external directories from ${id}.` : `Removed ${path.resolve(record.cwd, directory!)} from ${id}.`));
});
session.command("checkpoints").argument("<id>").option("--json", "Output raw JSON").description("List filesystem checkpoints for a session.").action(async (id: string, options: { json?: boolean }) => {
  const checkpoints = await listSessionCheckpoints(id);
  if (options.json) {
    console.log(JSON.stringify(checkpoints, null, 2));
    return;
  }
  if (!checkpoints.length) { console.log(pc.yellow("No checkpoints for this session.")); return; }
  for (const checkpoint of checkpoints) {
    const size = `${checkpoint.fileCount} files, ${formatBytes(checkpoint.totalBytes)}`;
    const truncated = checkpoint.truncated ? pc.yellow(" truncated") : "";
    console.log(`${pc.cyan(checkpoint.id)} ${pc.gray(checkpoint.createdAt)} ${checkpoint.toolName ?? "manual"} - ${checkpoint.reason} ${pc.gray(size)}${truncated}`);
  }
});
session.command("rewind-preview").argument("<id>").argument("<checkpointId>").option("--cwd <dir>", "Preview against this workspace instead of the checkpoint cwd").option("--json", "Output raw JSON").description("Preview files that checkpoint rewind would restore or delete.").action(async (id: string, checkpointId: string, options: { cwd?: string; json?: boolean }) => {
  const preview = await previewSessionCheckpointRestore(id, checkpointId, { cwd: options.cwd ? path.resolve(options.cwd) : undefined });
  if (options.json) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }
  console.log(pc.cyan(`Rewind preview ${id} -> ${checkpointId}`));
  console.log(`  restore: ${preview.restoreFiles.length} (${preview.changedFiles.length} changed, ${preview.missingFiles.length} missing)`);
  console.log(`  delete: ${preview.deleteFiles.length}`);
  for (const file of preview.restoreFiles.slice(0, 10)) console.log(pc.green(`  restore ${file}`));
  for (const file of preview.deleteFiles.slice(0, 10)) console.log(pc.red(`  delete ${file}`));
  for (const diff of preview.diffs.slice(0, 3)) {
    console.log(pc.cyan(`  diff ${diff.path}${diff.truncated ? " (truncated)" : ""}`));
    for (const line of diff.lines.slice(0, 12)) console.log(line.startsWith("-") ? pc.red(`    ${line}`) : pc.green(`    ${line}`));
  }
});
session.command("rewind").argument("<id>").argument("<checkpointId>").option("--cwd <dir>", "Restore into this workspace instead of the checkpoint cwd").option("--json", "Output raw JSON").description("Restore workspace files from a session checkpoint.").action(async (id: string, checkpointId: string, options: { cwd?: string; json?: boolean }) => {
  const result = await restoreSessionCheckpoint(id, checkpointId, { cwd: options.cwd ? path.resolve(options.cwd) : undefined });
  const restoredAt = new Date().toISOString();
  const audit = { checkpointId, sessionId: id, restoredAt, restoredFiles: result.restoredFiles, deletedFiles: result.deletedFiles };
  const event = { type: "checkpoint_restored" as const, ...audit };
  await appendCheckpointRestoreAudit(id, audit, event);
  if (options.json) {
    console.log(JSON.stringify({ ...result, audit, event }, null, 2));
    return;
  }
  console.log(pc.green(`Rewound ${id} to ${checkpointId}: restored ${result.restoredFiles} files, deleted ${result.deletedFiles} files.`));
});
session.command("compact").argument("<id>")
  .option("-p, --provider <provider>")
  .option("--model <model>")
  .option("--effort <level>", "Reasoning effort: none, low, medium, high, xhigh")
  .option("--preview", "Show the proposed summary without saving. Combine with --summary-file to apply an edit.")
  .option("--summary-file <path>", "Apply compaction using an edited summary read from this file.")
  .option("--json", "Output JSON result")
  .description("Compact a session's context now (LLM summary with deterministic fallback) and save in place.")
  .action(async (id: string, options: RunOptions & { json?: boolean; preview?: boolean; summaryFile?: string }) => {
    const config = readConfig();
    const providerId = options.provider ?? process.env.CREWCODER_PROVIDER ?? config.defaultProvider;
    const model = options.model ?? process.env.CREWCODER_MODEL ?? config.defaultModel;
    const record = await loadSession(id);
    const debug = createBackendDebugLogger({ runId: `compact-${id}-${Date.now()}` });
    const modelClient = new ProviderModelClient(providerId, process.cwd(), model, debug, normalizeEffortOption(options.effort));
    const prepared = await prepareLiveCompaction(record.messages, { modelClient });
    if (!prepared) {
      if (options.json) { console.log(JSON.stringify({ compacted: false }, null, 2)); return; }
      console.log(pc.yellow("Nothing to compact: session is already small enough."));
      return;
    }
    // Compaction hooks must fire here too, not just in the live agent loop. Otherwise a hook
    // that pins facts into the summary would silently do nothing for manual `session compact`.
    const compactionHooks = await loadTrustedExtensionHooks();
    if (prepared.fallbackReason && !options.json) {
      console.log(pc.yellow(`Summary quality degraded: the model summarizer was not used. ${prepared.fallbackReason}`));
    }
    const hookOutcome = await runCompactionHooks(compactionHooks, {
      summary: prepared.summary,
      source: prepared.source,
      fallbackReason: prepared.fallbackReason,
      originalMessageCount: prepared.originalMessageCount,
      retainedMessageCount: prepared.retainedMessageCount,
      cwd: process.cwd(),
      sessionId: id
    });
    const proposal = hookOutcome.summary === prepared.summary ? prepared : { ...prepared, summary: hookOutcome.summary };
    for (const note of hookOutcome.notes) if (!options.json) console.log(pc.gray(`  ${note}`));
    if (options.preview && !options.summaryFile) {
      if (options.json) {
        console.log(JSON.stringify({ compacted: false, preview: true, source: proposal.source, fallbackReason: proposal.fallbackReason, originalMessageCount: proposal.originalMessageCount, retainedMessageCount: proposal.retainedMessageCount, summary: proposal.summary }, null, 2));
        return;
      }
      console.log(pc.cyan(`Compaction preview for ${id} (${proposal.source} summary, ${proposal.originalMessageCount} -> ${proposal.retainedMessageCount + 1} messages):`));
      console.log(proposal.summary);
      console.log(pc.gray("\nEdit this summary and apply with: crewcoder session compact <id> --summary-file <path>"));
      return;
    }
    const editedSummary = options.summaryFile ? fs.readFileSync(path.resolve(options.summaryFile), "utf8") : undefined;
    const result = applyCompactionProposal(proposal, { editedSummary });
    const updated: SessionRecord = {
      ...record,
      messages: result.messages,
      compactions: [...(record.compactions ?? []), result.compaction],
      usage: record.usage ? { ...record.usage, lastInputTokens: 0 } : record.usage,
      // Compaction replaces provider history; stale native continuation would reattach it.
      providerSessionIds: {}
    };
    await saveSession(updated);
    closeCodexWebSocketSessions(id);
    if (options.json) {
      console.log(JSON.stringify({ compacted: true, compactionId: result.compaction.id, edited: Boolean(editedSummary), source: proposal.source, fallbackReason: proposal.fallbackReason, originalMessageCount: result.compaction.originalMessageCount, retainedMessageCount: result.compaction.retainedMessageCount }, null, 2));
      return;
    }
    console.log(pc.green(`Compacted session ${id}: ${result.compaction.originalMessageCount} -> ${result.compaction.retainedMessageCount + 1} messages${editedSummary ? " (edited summary)" : ""}`));
  });

session.command("export").argument("<id>")
  .option("--html", "Export as a self-contained HTML transcript (default format).")
  .option("--out <path>", "Write to this file instead of stdout.")
  .description("Export a session as a self-contained HTML transcript with diffs and a cost rollup.")
  .action(async (id: string, options: { html?: boolean; out?: string }) => {
    const record = await loadSession(id);
    const html = renderSessionHtml(record);
    if (!options.out) { console.log(html); return; }
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, "utf8");
    console.log(pc.green(`Exported session ${id} to ${outPath}`));
  });
session.command("since").argument("<ref>", "A session id, ISO timestamp, or relative duration like 2h, 7d")
  .option("--json", "Output raw JSON")
  .option("--into <sessionId>", "Pre-load the change summary as resume context on this session for the next resume")
  .description("Summarize files touched, tools run, and decisions across sessions since a point in time.")
  .action(async (ref: string, options: { json?: boolean; into?: string }) => {
    const summary = await summarizeSessionsSince(ref, { cwd: process.cwd() });
    if (options.into) {
      const record = await loadSession(options.into);
      await saveSession({ ...record, pendingResumeContext: formatSessionSinceContext(summary) });
    }
    if (options.json) {
      console.log(JSON.stringify({ ...summary, into: options.into ?? null }, null, 2));
      return;
    }
    console.log(pc.cyan(`Changes since ${summary.ref} (${summary.since})`));
    if (summary.refSessionId) console.log(pc.gray(`  resolved from session ${summary.refSessionId}`));
    if (!summary.sessions.length) { console.log(pc.yellow("No sessions in this repo since that point.")); return; }
    console.log(`Sessions: ${summary.sessions.length}`);
    for (const entry of summary.sessions) {
      console.log(`${pc.cyan(entry.sessionId)} ${pc.gray(entry.startedAt)} ${entry.mode}`);
      console.log(`  prompt: ${entry.prompt.slice(0, 100)}`);
      if (entry.changedFiles.length) console.log(pc.gray(`  changed: ${entry.changedFiles.join(", ")}`));
      if (entry.toolsRun.length) console.log(pc.gray(`  tools: ${entry.toolsRun.map((run) => `${run.name}×${run.count}`).join(", ")}`));
      if (entry.decision) console.log(pc.gray(`  outcome: ${entry.decision}`));
    }
    if (summary.changedFiles.length) {
      console.log(pc.cyan("\nAll files touched:"));
      for (const file of summary.changedFiles) console.log(`  - ${file}`);
    }
    if (summary.toolsRun.length) console.log(pc.cyan(`\nTools run: ${summary.toolsRun.map((run) => `${run.name}×${run.count}`).join(", ")}`));
    if (options.into) console.log(pc.green(`\nPre-loaded summary into ${options.into}. Run: crewcoder session resume ${options.into}`));
  });

session.command("why").argument("<id>")
  .option("-p, --provider <provider>")
  .option("--model <model>")
  .option("--effort <level>", "Reasoning effort: none, low, medium, high, xhigh")
  .option("--show-evidence", "Also print the exact decision evidence handed to the model.")
  .option("--json", "Output raw JSON")
  .description("Explain the agent's last decision in this session in plain language.")
  .action(async (id: string, options: RunOptions & { json?: boolean; showEvidence?: boolean }) => {
    const config = readConfig();
    const providerId = options.provider ?? process.env.CREWCODER_PROVIDER ?? config.defaultProvider;
    const model = options.model ?? process.env.CREWCODER_MODEL ?? config.defaultModel;
    const record = await loadSession(id);
    const debug = createBackendDebugLogger({ runId: `why-${id}-${Date.now()}` });
    const modelClient = new ProviderModelClient(providerId, process.cwd(), model, debug, normalizeEffortOption(options.effort));
    const why = await explainLastDecision(record, { modelClient });
    if (!why) {
      if (options.json) { console.log(JSON.stringify({ explained: false, reason: "no_decision" }, null, 2)); return; }
      console.log(pc.yellow("Nothing to explain: this session has no assistant turn yet."));
      return;
    }
    if (options.json) {
      console.log(JSON.stringify({ explained: true, ...why, evidence: options.showEvidence ? formatDecisionEvidence(why.decision) : undefined }, null, 2));
      return;
    }
    console.log(pc.cyan(`Why (session ${id}, ${why.decision.toolCalls.length} tool call${why.decision.toolCalls.length === 1 ? "" : "s"} on the last turn)`));
    // A degraded explanation must announce itself; otherwise a transcript readout
    // reads exactly like real reasoning.
    if (why.fallbackReason) console.log(pc.yellow(`The model explainer was not used, so this is a transcript readout. ${why.fallbackReason}`));
    console.log(why.explanation);
    if (options.showEvidence) {
      console.log(pc.gray("\nEvidence:"));
      console.log(pc.gray(formatDecisionEvidence(why.decision)));
    }
  });

const plugin = program.command("plugin", { hidden: resolveIntegrationProfile(process.cwd(), readConfig()) !== "crewcode" }).description("CrewCode app plugin helpers.");
plugin.hook("preAction", () => {
  if (resolveIntegrationProfile(process.cwd(), readConfig()) !== "crewcode") {
    throw new Error("CrewCode plugin commands are disabled in the standalone profile. Enable them with: crewcoder profile use crewcode --project");
  }
});
plugin.command("create").argument("<id>").requiredOption("--kind <kind>", `Plugin kind: ${supportedPluginKinds.join(", ")}`).option("--out <dir>", "Output directory", process.cwd()).action(async (id: string, options: { kind: string; out: string }) => {
  if (!isSupportedPluginKind(options.kind)) throw new Error(`Unsupported kind. Supported kinds: ${supportedPluginKinds.join(", ")}`);
  const files = await createPlugin(id, options.kind as PluginKind, options.out);
  console.log(pc.green(`Created ${options.kind} CrewCode app plugin: ${path.resolve(options.out, id)}`));
  for (const file of files) console.log(`  - ${file}`);
});
plugin.command("validate").argument("<dir>").action((dir: string) => {
  const result = validatePlugin(path.resolve(dir));
  console.log(result.ok ? pc.green("Plugin validation passed.") : pc.red("Plugin validation failed."));
  for (const error of result.errors) console.log(pc.red(`  error: ${error}`));
  for (const warning of result.warnings) console.log(pc.yellow(`  warning: ${warning}`));
  if (!result.ok) process.exitCode = 1;
});
plugin.command("test").argument("<dir>")
  .option("--workspace <dir>", "Workspace root the sandboxed host is rooted at (defaults to the plugin folder)")
  .option("--entry <path>", "Only test one contribution entry, e.g. panel.html")
  .option("--timeout <ms>", "Per-entry wall-clock ceiling", "10000")
  .option("--json", "Output raw JSON")
  .description("Load a CrewCode plugin in a sandboxed host, drive a scripted interaction, and check the v0 contract.")
  .action(async (dir: string, options: { workspace?: string; entry?: string; timeout: string; json?: boolean }) => {
    const timeoutMs = Number.parseInt(options.timeout, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be a positive number of milliseconds");
    const report = await runPluginTest({
      pluginDir: path.resolve(dir),
      ...(options.workspace ? { workspaceRoot: path.resolve(options.workspace) } : {}),
      ...(options.entry ? { entry: options.entry } : {}),
      timeoutMs
    });
    if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
    printPluginTestReport(report);
    if (!report.ok) process.exitCode = 1;
  });

function printPluginTestReport(report: PluginTestReport): void {
  console.log(report.ok ? pc.green(`Plugin smoke test passed: ${report.pluginId}`) : pc.red(`Plugin smoke test failed: ${report.pluginId}`));
  console.log(pc.gray(`workspace: ${report.workspaceRoot}`));
  console.log(pc.gray(`permissions: ${report.permissions.length ? report.permissions.join(", ") : "(none declared)"}`));

  for (const finding of report.findings) console.log(formatPluginFinding(finding));

  for (const entry of report.entries) {
    const status = entry.ok ? pc.green("ok") : pc.red("failed");
    console.log(`\n${pc.bold(entry.entry.entry)} ${pc.gray(`(${entry.entry.contribution}:${entry.entry.id})`)} ${status} ${pc.gray(`${entry.durationMs}ms`)}`);
    console.log(pc.gray(`  scripts: ${entry.scripts.length ? entry.scripts.join(", ") : "(none)"}`));
    if (entry.interactions.length) {
      const bound = entry.interactions.filter((interaction) => interaction.dispatched).length;
      console.log(pc.gray(`  interactions: ${entry.interactions.length} clicked, ${bound} had a handler bound`));
    }
    for (const call of entry.calls) {
      const mark = call.ok ? pc.green("allowed") : pc.red("denied");
      console.log(`  ${mark} ${call.method}${call.ok ? "" : pc.gray(` - ${call.error}`)}`);
    }
    for (const finding of entry.findings) console.log(`  ${formatPluginFinding(finding)}`);
  }

  // Never let a green result imply more than it proves.
  console.log(pc.gray("\nWhat this run does not cover:"));
  for (const limitation of report.limitations) console.log(pc.gray(`  - ${limitation}`));
}

function formatPluginFinding(finding: PluginTestFinding): string {
  const label = finding.severity === "error" ? pc.red("error") : finding.severity === "warning" ? pc.yellow("warning") : pc.cyan("info");
  return `${label} ${pc.gray(`[${finding.code}]`)} ${finding.message}`;
}

plugin.command("list-templates").option("--path <dir>", "Discovery path", process.cwd()).action((options: { path: string }) => {
  for (const template of listTemplates(path.resolve(options.path))) {
    const status = template.available ? pc.green("available") : pc.yellow("fallback");
    console.log(`${pc.cyan(template.kind)} -> ${template.templateName} (${status})`);
    if (template.sourcePath) console.log(pc.gray(`  ${template.sourcePath}`));
  }
});

const gitCommand = program.command("git").description("Git workflow helpers.");
gitCommand.command("review-summary").option("--json", "Output raw JSON").description("Show branch, changed files, and issue references for review workflows.").action(async (options: { json?: boolean }) => {
  const summary = await createGitWorkflowHelpers({ cwd: process.cwd() }).reviewSummary();
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(pc.cyan(`Branch: ${summary.branch ?? "(none)"}`));
  console.log(`Status: ${summary.clean ? pc.green("clean") : pc.yellow("dirty")}`);
  if (summary.changedFiles.length) {
    console.log(pc.cyan("Changed files:"));
    for (const file of summary.changedFiles) console.log(`  - ${file}`);
  }
  if (summary.issueReferences.length) {
    console.log(pc.cyan("Issue references:"));
    for (const issue of summary.issueReferences) console.log(`  - ${issue.text} (${issue.source})${issue.url ? ` ${pc.gray(issue.url)}` : ""}`);
  }
});

const hook = program.command("hook").description("Install and manage Git hooks backed by CrewCoder.");
hook.command("install", { isDefault: true })
  .option("--command <path>", "CrewCoder executable written into the hook", "crewcoder")
  .option("--budget <tokens>", "Token budget for each pre-commit review")
  .option("--force", "Back up a non-CrewCoder pre-commit hook and replace it")
  .description("Install or update a managed pre-commit hook that reviews staged changes through crewcoder run --ci.")
  .action((options: { command: string; budget?: string; force?: boolean }) => {
    if (options.budget) parseTokenBudget(options.budget);
    const result = installPreCommitHook({ cwd: process.cwd(), command: options.command, budget: options.budget, force: options.force });
    const verb = result.status === "unchanged" ? "Already current" : result.status === "updated" ? "Updated" : result.status === "replaced" ? "Replaced" : "Installed";
    console.log(pc.green(`${verb} CrewCoder pre-commit hook: ${result.hookPath}`));
    if (result.backupPath) console.log(pc.yellow(`Existing hook backed up to: ${result.backupPath}`));
    console.log(pc.gray("Set CREWCODER_PRE_COMMIT_SKIP=1 for a one-off bypass."));
  });

const extension = program.command("extension").description("CrewCoder extension helpers.");
const createExtensionAction = async (id: string, options?: { kind?: string }) => {
  if (options?.kind) console.log(pc.yellow("--kind is deprecated and ignored. CrewCoder extensions are capability-based; edit contributes in crewcoder.extension.json."));
  const files = await createCrewCoderExtension(id);
  console.log(pc.green(`Created CrewCoder extension: ${path.join(ensureCrewCoderHome().extensionsDir, id)}`));
  for (const file of files) console.log(`  - ${file}`);
};
extension.command("init").argument("<id>").description("Initialize a capability-based CrewCoder extension package.").action(createExtensionAction);
extension.command("create").argument("<id>").option("--kind <kind>", "Deprecated; ignored because extensions are capability-based").description("Alias for extension init.").action(createExtensionAction);
const reportInstall = (result: ExtensionInstallResult, verb: string, grantedTier?: TrustTier): void => {
  console.log(pc.green(`${verb} ${result.id} (${result.name} v${result.version})`));
  console.log(pc.gray(`  source: ${result.record.spec}${result.record.commit ? ` @ ${result.record.commit.slice(0, 8)}` : ""}`));
  if (result.record.alias) console.log(pc.gray(`  registry: ${result.record.alias} via ${result.record.registry}`));
  console.log(pc.gray(`  path:   ${result.dir}`));
  if (result.backupDir) console.log(pc.gray(`  backup: ${result.backupDir}`));
  const capabilities = formatCapabilitySummary(result.capabilities);
  if (capabilities.length) console.log(`  contributes: ${capabilities.join(", ")}`);
  if (result.capabilities.networkHosts.length) console.log(pc.yellow(`  network: ${result.capabilities.networkHosts.join(", ")}`));
  for (const warning of result.manifestWarnings) console.log(pc.yellow(`  warning: ${warning}`));
  if (grantedTier && grantedTier !== "prompt-only") {
    console.log(pc.yellow(`  Trust granted on install: ${grantedTier}. Its executable contributions can run.`));
  } else if (result.capabilities.requiresTrust) {
    console.log(pc.yellow("  Executable contributions stay inert at the default prompt-only tier."));
    console.log(`  Grant access with: ${pc.bold(`crewcoder extension trust ${result.id} --tier sandboxed`)}`);
  }
};
extension.command("install")
  .argument("<source>", "a registry id, owner/repo, owner/repo@ref, owner/repo@ref#subdir, a git URL, or a local path")
  .option("--from <source>", "Explicit git URL or local path, overriding the shorthand")
  .option("--ref <ref>", "Branch, tag, or commit to install")
  .option("--subdir <path>", "Package subdirectory inside the source repository")
  .option("--force", "Replace an existing install of the same id (the old copy is backed up)")
  .option("--trust <tier>", "Grant a trust tier immediately: trusted, sandboxed, or prompt-only")
  .description("Install a CrewCoder extension from GitHub, a git URL, or a local path.")
  .action(async (source: string, options: { from?: string; ref?: string; subdir?: string; force?: boolean; trust?: string }) => {
    if (options.trust !== undefined && !isTrustTier(options.trust)) throw new Error("Trust tier must be one of: trusted, sandboxed, prompt-only");
    const result = await installExtension(source, options);
    if (options.trust && isTrustTier(options.trust)) setExtensionTrustTier(result.id, options.trust);
    reportInstall(result, "Installed", options.trust && isTrustTier(options.trust) ? options.trust : undefined);
  });
extension.command("update")
  .argument("<id>")
  .description("Reinstall an extension from the source recorded at install time.")
  .action(async (id: string) => {
    reportInstall(await updateExtension(id), "Updated");
  });
extension.command("uninstall")
  .argument("<id>")
  .description("Remove an installed extension and clear its trust/enable state.")
  .action(async (id: string) => {
    const result = await uninstallExtension(id);
    console.log(pc.yellow(`Uninstalled ${result.id}`));
    console.log(pc.gray(`  backup: ${result.backupDir}`));
    if (result.configCleaned) console.log(pc.gray("  cleared trust/enable state from config"));
  });
extension.command("search")
  .argument("[query...]", "Words to match against extension ids, names, keywords, and descriptions")
  .option("--json", "Output raw JSON")
  .option("--limit <n>", "Maximum number of results", "20")
  .option("--registry <match>", "Only search registries whose URL contains this string")
  .option("--refresh", "Bypass the registry cache and re-fetch")
  .description("Search configured extension registries. Install a hit by id: crewcoder extension install <id>")
  .action(async (query: string[], options: { json?: boolean; limit?: string; registry?: string; refresh?: boolean }) => {
    const limit = Number(options.limit ?? "20");
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
    const result = await searchRegistries((query ?? []).join(" "), { limit, registry: options.registry, refresh: options.refresh });
    if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }

    for (const registry of result.registries) {
      if (registry.error) console.log(pc.yellow(`registry ${registry.url}: ${registry.error}`));
    }
    if (!result.registries.length) {
      console.log(pc.yellow("No extension registries enabled."));
      console.log(pc.gray("Add one with: crewcoder extension registry add <url-or-path>"));
      console.log(pc.gray(`Re-enable the built-in registry with: crewcoder extension registry add ${DEFAULT_EXTENSION_REGISTRY}`));
      return;
    }
    if (!result.hits.length) { console.log(pc.yellow("No matching extensions.")); return; }
    for (const hit of result.hits) {
      const state = hit.installed ? pc.green(" [installed]") : "";
      console.log(`${pc.cyan(hit.entry.id)}${hit.entry.version ? pc.gray(` v${hit.entry.version}`) : ""} - ${hit.entry.name}${state}`);
      if (hit.entry.description) console.log(`  ${hit.entry.description}`);
      console.log(pc.gray(`  source: ${hit.entry.source}  registry: ${hit.registryName}`));
      if (hit.entry.contributes.length) console.log(pc.gray(`  contributes: ${hit.entry.contributes.join(", ")}`));
      if (hit.entry.requiresTrust) console.log(pc.yellow("  ships executable contributions; stays prompt-only until you grant trust"));
    }
    console.log(pc.gray(`Install with: crewcoder extension install <id>`));
  });

const registry = extension.command("registry").description("Manage extension registry index sources.");
registry.command("list", { isDefault: true })
  .option("--json", "Output raw JSON")
  .option("--refresh", "Bypass the registry cache and re-fetch")
  .description("List configured registries and their status.")
  .action(async (options: { json?: boolean; refresh?: boolean }) => {
    const registries = await loadRegistries({ refresh: options.refresh });
    if (options.json) { console.log(JSON.stringify(registries, null, 2)); return; }
    if (!registries.length) {
      console.log(pc.yellow("No extension registries enabled."));
      console.log(pc.gray("Add one with: crewcoder extension registry add <url-or-path>"));
      console.log(pc.gray(`Re-enable the built-in registry with: crewcoder extension registry add ${DEFAULT_EXTENSION_REGISTRY}`));
      return;
    }
    for (const entry of registries) {
      const count = entry.index ? `${entry.index.extensions.length} extension${entry.index.extensions.length === 1 ? "" : "s"}` : pc.red("unavailable");
      // An unavailable registry has no index to read a name from, so name falls back to the URL.
      const label = entry.name === entry.url ? pc.cyan(entry.url) : `${pc.cyan(entry.name)} ${pc.gray(entry.url)}`;
      console.log(`${label}${entry.builtin ? pc.gray(" (built-in)") : ""}`);
      console.log(`  ${count}${entry.fetchedAt ? pc.gray(` fetched ${entry.fetchedAt}${entry.fromCache ? " (cached)" : ""}`) : ""}`);
      if (entry.error) console.log(pc.yellow(`  ${entry.error}`));
    }
  });
registry.command("add").argument("<url>", "Registry index URL or local JSON path").description("Add a registry index source (re-enables the built-in registry if given its URL).").action((url: string) => {
  const registries = addRegistry(url);
  console.log(pc.green(`Registries: ${registries.join(", ")}`));
});
registry.command("remove").argument("<url>").description("Remove a registry index source, or disable the built-in registry by its URL.").action((url: string) => {
  const result = removeRegistry(url);
  if (!result.removed) { console.log(pc.yellow(`Registry not configured: ${url}`)); return; }
  console.log(pc.green(result.registries.length ? `Registries: ${result.registries.join(", ")}` : "No registries enabled."));
});
registry.command("refresh").description("Clear the registry cache and re-fetch every configured index.").action(async () => {
  await clearRegistryCache();
  const registries = await loadRegistries({ refresh: true });
  if (!registries.length) { console.log(pc.yellow("No extension registries enabled.")); return; }
  for (const entry of registries) {
    if (entry.error) console.log(pc.yellow(`${entry.url}: ${entry.error}`));
    else console.log(pc.green(`${entry.url}: ${entry.index?.extensions.length ?? 0} extensions`));
  }
});

extension.command("list").action(async () => {
  const extensions = await loadCrewCoderExtensions();
  if (!extensions.length) { console.log(pc.yellow("No CrewCoder extensions installed.")); console.log(pc.gray(`Extensions directory: ${ensureCrewCoderHome().extensionsDir}`)); return; }
  for (const ext of extensions) {
    console.log(`${pc.cyan(ext.manifest.id)} - ${ext.manifest.name} v${ext.manifest.version}`);
    console.log(pc.gray(`  ${ext.dir}`));
    for (const warning of ext.warnings) console.log(pc.yellow(`  warning: ${warning}`));
  }
});
extension.command("inspect").argument("<id>").action(async (id: string) => {
  const ext = await inspectExtension(id);
  if (!ext) throw new Error(`Extension not found: ${id}`);
  console.log(JSON.stringify(ext, null, 2));
});
extension.command("enable").argument("<id>").action((id: string) => { setExtensionEnabled(id, true); console.log(pc.green(`Enabled ${id}`)); });
extension.command("disable").argument("<id>").action((id: string) => { setExtensionEnabled(id, false); console.log(pc.yellow(`Disabled ${id}`)); });
extension.command("trust").argument("<id>").option("--tier <tier>", "trusted, sandboxed, prompt-only", "trusted").action((id: string, options: { tier?: string }) => {
  const tier = options.tier ?? "trusted";
  if (!isTrustTier(tier)) throw new Error("Trust tier must be one of: trusted, sandboxed, prompt-only");
  setExtensionTrustTier(id, tier);
  console.log(pc.green(`Set ${id} trust tier to ${tier}`));
});
extension.command("untrust").argument("<id>").action((id: string) => { setExtensionTrusted(id, false); console.log(pc.yellow(`Untrusted ${id} (prompt-only)`)); });
extension.command("tier").argument("<id>").description("Show the effective trust tier for an extension.").action((id: string) => { console.log(getExtensionTrustTier(id)); });
extension.command("validate").argument("<path>").action(async (extensionPath: string) => {
  const result = await validateExtensionPath(path.resolve(extensionPath));
  console.log(result.ok ? pc.green("Extension validation passed.") : pc.red("Extension validation failed."));
  for (const error of result.errors) console.log(pc.red(`  error: ${error}`));
  for (const warning of result.warnings) console.log(pc.yellow(`  warning: ${warning}`));
  if (!result.ok) process.exitCode = 1;
});
extension.command("renderers").option("--json", "Output raw JSON").description("List trusted declarative TUI renderers.").action(async (options: { json?: boolean }) => {
  const renderers = await listTrustedExtensionRenderers();
  if (options.json) {
    console.log(JSON.stringify(renderers, null, 2));
    return;
  }
  if (!renderers.length) { console.log(pc.yellow("No trusted extension renderers available.")); return; }
  for (const renderer of renderers) {
    console.log(`${pc.cyan(renderer.extensionId)}:${renderer.id} ${pc.gray(renderer.target)} - ${renderer.title}`);
  }
});
extension.command("hooks").option("--json", "Output raw JSON").description("List active trusted extension hooks.").action(async (options: { json?: boolean }) => {
  const hooks = await loadTrustedExtensionHooks();
  if (options.json) { console.log(JSON.stringify(hooks, null, 2)); return; }
  if (!hooks.length) { console.log(pc.yellow("No trusted extension hooks active.")); console.log(pc.gray("Hooks require allowExtensionHooks=true and a trusted extension.")); return; }
  for (const hook of hooks) {
    const matchers = [
      hook.matches.tools?.length ? `tools=${hook.matches.tools.join("|")}` : "",
      hook.matches.paths?.length ? `paths=${hook.matches.paths.join("|")}` : "",
      hook.matches.commands?.length ? `commands=${hook.matches.commands.join("|")}` : ""
    ].filter(Boolean).join(" ");
    console.log(`${pc.cyan(hook.extensionId)}:${hook.hookId} ${pc.bold(hook.event)} - ${hook.title}`);
    const scope = hook.event === "context" || hook.event === "compaction" ? "" : matchers ? ` [${matchers}]` : " [all tool calls]";
    console.log(pc.gray(`  ${hook.command} ${hook.args.join(" ")}${scope}`));
  }
});
extension.command("approval-policies").option("--json", "Output raw JSON").description("List trusted extension approval policies.").action(async (options: { json?: boolean }) => {
  const policies = await loadTrustedExtensionApprovalPolicies();
  if (options.json) {
    console.log(JSON.stringify(policies, null, 2));
    return;
  }
  if (!policies.length) { console.log(pc.yellow("No trusted extension approval policies active.")); return; }
  for (const policy of policies) {
    const matchers = [
      policy.tools.length ? `tools=${policy.tools.join(",")}` : "",
      policy.paths.length ? `paths=${policy.paths.join(",")}` : "",
      policy.commands.length ? `commands=${policy.commands.join(",")}` : ""
    ].filter(Boolean).join(" ");
    const reason = policy.reason ? ` ${pc.gray(policy.reason)}` : "";
    console.log(`${pc.cyan(policy.extensionId)}:${policy.policyId} ${pc.bold(policy.action)} - ${policy.title}${matchers ? ` ${pc.gray(matchers)}` : ""}${reason}`);
  }
});

extension.command("live-ui").option("--json", "Output raw JSON").description("Inspect experimental live UI contributions and their trust-gate status.").action(async (options: { json?: boolean }) => {
  const contributions = await listLiveUiContributions();
  if (options.json) {
    console.log(JSON.stringify(contributions, null, 2));
    return;
  }
  if (!contributions.length) { console.log(pc.yellow("No live UI contributions declared by installed extensions.")); return; }
  for (const contribution of contributions) {
    const status = contribution.allowed ? pc.green("allowed") : pc.yellow("blocked");
    console.log(`${pc.cyan(contribution.extensionId)}:${contribution.id} ${pc.gray(contribution.surface)} ${status} - ${contribution.title}`);
    console.log(pc.gray(`  entry: ${contribution.entry}`));
    for (const reason of contribution.blockedReasons) console.log(pc.yellow(`  blocked: ${reason}`));
  }
});

program.command("login").argument("<provider>").description("Login to a subscription/OAuth provider or persist a provider API key from env.").action(async (provider: string) => {
  if (provider !== "codex") {
    await importProviderEnvKey(provider);
    return;
  }
  const credential = await loginCodexDeviceCode({
    onDeviceCode: (info) => {
      console.log(pc.cyan("OpenAI Codex login"));
      console.log(`Open: ${pc.bold(info.verificationUri)}`);
      console.log(`Code: ${pc.bold(info.userCode)}`);
      void openUrlInDefaultBrowser(info.verificationUri).then((opened) => {
        console.log(opened ? pc.gray("Opened the login page in your default browser.") : pc.yellow("Could not open the login page automatically. Use the URL above."));
      });
      console.log(pc.gray(`Expires in ${Math.round(info.expiresInSeconds / 60)} minutes. Waiting for authorization...`));
    },
    onPoll: (message) => console.log(pc.gray(message))
  });
  setAuthCredential("codex", credential);
  console.log(pc.green(`Logged in to codex. Auth saved to ${getAuthPath()}`));
});

program.command("logout").argument("<provider>").description("Remove stored provider credentials.").action((provider: string) => {
  removeAuthCredential(provider);
  console.log(pc.yellow(`Logged out of ${provider}.`));
});

const auth = program.command("auth").description("Show and import provider auth status.");
auth.action(async () => {
  const auth = readAuthFile();
  const providers = await listProviders();
  let printed = false;
  for (const provider of providers) {
    const credential = auth[provider.id];
    if (credential) {
      console.log(`${pc.cyan(provider.id)}: ${credential.type} stored`);
      printed = true;
      continue;
    }
    if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) {
      console.log(`${pc.cyan(provider.id)}: env ${provider.apiKeyEnv}`);
      printed = true;
    }
  }
  if (!printed) console.log(pc.yellow("No stored credentials or provider env keys found."));
});
auth.command("import-env")
  .argument("[provider]", "Provider id. Omit to import all provider API keys visible in the current environment.")
  .description("Persist provider API keys from the current process environment into CrewCoder auth storage.")
  .action(async (provider?: string) => {
    if (provider) {
      await importProviderEnvKey(provider);
      return;
    }
    const imported: string[] = [];
    for (const item of await listProviders()) {
      if (!item.apiKeyEnv || !process.env[item.apiKeyEnv]) continue;
      setAuthCredential(item.id, { type: "api_key", key: process.env[item.apiKeyEnv]! });
      setAuthCredential(item.apiKeyEnv, { type: "api_key", key: process.env[item.apiKeyEnv]! });
      imported.push(item.id);
    }
    if (!imported.length) throw new Error("No provider API keys were visible in this environment.");
    console.log(pc.green(`Imported API keys for: ${imported.join(", ")}`));
    console.log(pc.gray(`Auth saved to ${getAuthPath()}`));
  });

const workflow = program.command("workflow").description("Deterministic tool+prompt sequences contributed by extensions.");
workflow.command("list", { isDefault: true }).option("--json", "Output raw JSON").description("List workflows from enabled extensions.").action(async (options: { json?: boolean }) => {
  const entries = await listWorkflows();
  if (options.json) { console.log(JSON.stringify(entries, null, 2)); return; }
  if (!entries.length) { console.log(pc.yellow("No workflows contributed by enabled extensions.")); return; }
  for (const entry of entries) {
    const status = entry.runnable ? pc.green("runnable") : pc.yellow(`needs trust (${entry.tier})`);
    console.log(`${pc.cyan(entry.ref)} ${status} - ${entry.title}`);
    console.log(pc.gray(`  ${entry.steps.length} step${entry.steps.length === 1 ? "" : "s"}${entry.description ? ` - ${entry.description}` : ""}`));
  }
});
workflow.command("show").argument("<ref>").option("--json", "Output raw JSON").description("Print the exact step plan before running it.").action(async (ref: string, options: { json?: boolean }) => {
  const entry = await findWorkflow(ref);
  if (options.json) { console.log(JSON.stringify(entry, null, 2)); return; }
  console.log(`${pc.cyan(entry.ref)} - ${entry.title}`);
  if (entry.description) console.log(pc.gray(`  ${entry.description}`));
  console.log(pc.gray(`  extension: ${entry.extensionId} (${entry.tier})`));
  for (const line of describeWorkflow(entry)) console.log(`  ${line}`);
  if (!entry.runnable) console.log(pc.yellow(`  Tool steps need trust: crewcoder extension trust ${entry.extensionId} --tier sandboxed`));
});
workflow.command("run").argument("<ref>")
  .option("-p, --provider <provider>", "codex, claude, opencode, or extension provider")
  .option("-m, --model <model>", "Model id for prompt steps")
  .option("--json", "Output the run result as JSON")
  .description("Run a workflow's steps in order.")
  .action(async (ref: string, options: { provider?: string; model?: string; json?: boolean }) => {
    const result = await runWorkflow(ref, {
      cwd: process.cwd(),
      providerId: options.provider,
      model: options.model,
      onStep: options.json ? undefined : (step) => {
        const mark = step.status === "ok" ? pc.green("ok") : step.status === "skipped" ? pc.gray("skipped") : pc.red("failed");
        console.log(`${pc.cyan(`[${step.index + 1}:${step.id}]`)} ${step.kind} ${mark}${step.error ? ` - ${step.error}` : ""}`);
      }
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.ok ? pc.green(`Workflow ${result.ref} completed.`) : pc.red(`Workflow ${result.ref} failed.`));
    if (!result.ok) process.exitCode = 1;
  });

program.command("providers").description("List built-in and extension providers.").option("--json", "Print providers as JSON for TUI/automation consumers.").action(async (options: { json?: boolean }) => {
  const providers = await listProviders();
  if (options.json) {
    console.log(JSON.stringify(providers.map((provider) => ({
      id: provider.id,
      title: provider.title,
      kind: provider.kind,
      models: listProviderModelIds(provider),
      defaultModel: provider.defaultModel,
      transport: resolveProviderTransport(provider),
      description: provider.description
    })), null, 2));
    return;
  }
  for (const provider of providers) {
    const label = provider.kind === "builtin" ? pc.green("builtin") : pc.cyan("extension");
    console.log(`${pc.bold(provider.id)} (${label}) - ${provider.title}`);
    console.log(`  command: ${provider.command}`);
    if (provider.endpoint) console.log(`  endpoint: ${provider.endpoint}`);
    if (provider.apiKeyEnv) console.log(`  apiKeyEnv: ${provider.apiKeyEnv}`);
    console.log(`  models: ${listProviderModelIds(provider).join(", ")}`);
    if (provider.defaultModel) console.log(`  default: ${provider.defaultModel}`);
    console.log(`  runtime: ${provider.runtime}`);
    const transport = resolveProviderTransport(provider);
    console.log(`  transport: ${transport.channel} (${transport.continuation}${transport.fallback ? `, fallback ${transport.fallback}` : ""})`);
    if (provider.description) console.log(pc.gray(`  ${provider.description}`));
  }
});
program.command("diff-models")
  .argument("<prompt...>")
  .requiredOption("--models <list>", "Comma-separated candidates: provider:model, a provider id, or a bare model id (repeatable)", collectModelSpec, [])
  .option("--effort <level>", "Reasoning effort applied to every candidate: none, low, medium, high, xhigh")
  .option("--system-prompt <name>", "Use a stored custom system prompt instead of the neutral comparison prompt")
  .option("--sequential", "Run candidates one at a time instead of in parallel")
  .option("--no-ledger", "Do not record these turns in the cost ledger")
  .option("--full", "Print each full response instead of a preview")
  .option("--json", "Output raw JSON")
  .description("Run one prompt against N models side by side and compare response, cost, and latency.")
  .action(async (promptParts: string[], options: { models: string[]; effort?: string; systemPrompt?: string; sequential?: boolean; ledger?: boolean; full?: boolean; json?: boolean }) => {
    const prompt = promptParts.join(" ").trim();
    if (!prompt) throw new Error("A prompt is required.");
    const config = readConfig();
    const providers = await listProviders();
    const candidates = parseModelSpecs(options.models, {
      knownProviderIds: providers.map((provider) => provider.id),
      defaultProviderId: process.env.CREWCODER_PROVIDER ?? config.defaultProvider
    });
    if (!candidates.length) throw new Error("No models to compare. Pass --models codex:gpt-5.6,opencode:claude-sonnet-4-6");

    const effort = normalizeEffortOption(options.effort);
    const storedPrompt = options.systemPrompt ? getSystemPrompt(options.systemPrompt) : undefined;
    const runId = `diff-models-${Date.now()}`;
    const report = await diffModels({
      prompt,
      candidates,
      concurrent: !options.sequential,
      ...(storedPrompt ? { systemPrompt: storedPrompt.content } : {}),
      createModelClient: (candidate) => new ProviderModelClient(
        candidate.providerId,
        process.cwd(),
        candidate.model,
        createBackendDebugLogger({ runId: `${runId}-${candidate.label}` }),
        effort
      )
    });

    // These are real billed turns, so they belong in the ledger like any other.
    if (options.ledger !== false) {
      const worker = getActiveWorker().name;
      for (const result of report.results) {
        if (!result.usage) continue;
        await recordModelUsageCost(
          { ...result.usage, providerId: result.candidate.providerId, model: result.candidate.model },
          { worker, cwd: process.cwd() }
        );
      }
    }

    if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
    printModelDiffReport(report, Boolean(options.full));
    if (report.results.some((result) => !result.ok)) process.exitCode = 1;
  });

function printModelDiffReport(report: ModelDiffReport, full: boolean): void {
  console.log(pc.cyan(`Model diff (${report.results.length} model${report.results.length === 1 ? "" : "s"}, ${report.concurrent ? "parallel" : "sequential"}, ${report.totalMs}ms total)`));
  console.log(pc.gray(`prompt: ${report.prompt.split("\n")[0]?.slice(0, 120) ?? ""}`));
  console.log("");
  const fastest = Math.min(...report.results.filter((result) => result.ok).map((result) => result.latencyMs));
  for (const result of report.results) {
    const status = result.ok ? pc.green("ok") : pc.red("failed");
    const latency = result.ok && result.latencyMs === fastest ? pc.green(`${result.latencyMs}ms`) : `${result.latencyMs}ms`;
    // An unpriced model must read as unknown, never as free.
    const cost = result.usage ? (typeof result.costUsd === "number" ? formatUsd(result.costUsd) : pc.yellow("unpriced")) : pc.gray("no usage reported");
    const tokens = result.usage ? `${result.usage.totalTokens ?? 0} tok (in ${result.usage.inputTokens ?? 0} / out ${result.usage.outputTokens ?? 0})` : "-";
    console.log(`${pc.bold(result.candidate.label)}  ${status}  ${latency}  ${cost}  ${pc.gray(tokens)}`);
    if (result.errorMessage) { console.log(pc.red(`  ${result.errorMessage}`)); continue; }
    const body = full ? result.text : previewResponse(result.text);
    for (const line of body.split("\n")) console.log(`  ${line}`);
    console.log("");
  }
}

function previewResponse(text: string): string {
  const lines = text.split("\n").slice(0, 8);
  const preview = lines.join("\n");
  return preview.length < text.length ? `${preview}\n${pc.gray("… (use --full for the whole response)")}` : preview || pc.gray("(empty response)");
}

// Collector for repeatable --models flags; comma splitting happens in parseModelSpecs.
function collectModelSpec(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

const workers = program.command("workers").description("Manage CrewCoder workers (named agent identities).");
workers.command("list", { isDefault: true }).option("--json", "Output raw JSON").description("List available workers.").action((options: { json?: boolean }) => {
  const active = getActiveWorker();
  const all = listWorkers();
  if (options.json) {
    console.log(JSON.stringify(all.map((w) => ({ name: w.name, active: w.name === active.name, ownerName: w.identity.ownerName ?? null, description: w.identity.description ?? null })), null, 2));
    return;
  }
  if (!all.length) { console.log(pc.yellow("No workers found.")); return; }
  for (const w of all) {
    const marker = w.name === active.name ? pc.green("*") : " ";
    console.log(`${marker} ${pc.bold(w.name)}${w.identity.ownerName ? pc.gray(` (owner: ${w.identity.ownerName})`) : ""}`);
    if (w.identity.description) console.log(`    ${pc.gray(w.identity.description)}`);
  }
});
workers.command("use").argument("<name>").description("Switch the active worker.").action((name: string) => {
  const w = setActiveWorker(name);
  console.log(pc.green(`Active worker is now ${w.name}.`));
});
workers.command("create").argument("<name>").option("--owner <name>", "Owner name").option("--handle <handle>", "Owner handle").option("--description <text>", "Short description").description("Create a new worker (folder with identity.json + IDENTITY.md).").action((name: string, options: { owner?: string; handle?: string; description?: string }) => {
  const w = createWorker(name, { ownerName: options.owner, ownerHandle: options.handle, description: options.description });
  console.log(pc.green(`Created worker ${w.name}.`));
  console.log(pc.gray(`  identity: ${path.join(w.dir, "identity.json")}`));
  console.log(pc.gray(`  identity-md: ${path.join(w.dir, "IDENTITY.md")}`));
});
workers.command("show").argument("[name]").description("Show a worker (active worker if omitted).").action((name?: string) => {
  const w = name ? (listWorkers().find((x) => x.name === name) ?? null) : getActiveWorker();
  if (!w) throw new Error(`Worker not found: ${name}`);
  console.log(JSON.stringify({ name: w.name, dir: w.dir, identity: w.identity, hasInstructions: Boolean(w.instructions && w.instructions.trim()) }, null, 2));
});
workers.command("set").argument("<name>").argument("<key>").argument("<value>").description("Set a worker identity field: owner-name, owner-handle, description").action((name: string, key: string, value: string) => {
  const allowed: IdentitySetKey[] = ["owner-name", "owner-handle", "description"];
  if (!allowed.includes(key as IdentitySetKey)) throw new Error(`Supported keys: ${allowed.join(", ")}`);
  const w = setWorkerIdentityValue(name, key as IdentitySetKey, value);
  console.log(pc.green(`Updated ${w.name}.`));
  console.log(JSON.stringify(w.identity, null, 2));
});
workers.command("path").argument("[name]").description("Print the IDENTITY.md path for a worker (active if omitted).").action((name?: string) => {
  const target = name ?? getActiveWorker().name;
  console.log(getWorkerIdentityMdPath(target));
});
workers.command("delete").argument("<name>").description("Delete a worker.").action((name: string) => {
  const active = getActiveWorker();
  deleteWorker(name);
  console.log(pc.yellow(`Deleted worker ${name}.`));
  if (active.name === name) {
    const next = getActiveWorker();
    console.log(pc.gray(`Active worker reset to ${next.name}.`));
  }
});

const identity = program.command("identity").description("Manage the active worker's identity (shortcut for workers).");
identity.command("show", { isDefault: true }).description("Show the active worker identity.").action(() => {
  const w = getActiveWorker();
  console.log(JSON.stringify({ worker: w.name, ...w.identity }, null, 2));
});
identity.command("set").argument("<key>").argument("<value>").description("Set a field on the active worker: owner-name, owner-handle, description").action((key: string, value: string) => {
  const allowed: IdentitySetKey[] = ["owner-name", "owner-handle", "description"];
  if (!allowed.includes(key as IdentitySetKey)) throw new Error(`Supported keys: ${allowed.join(", ")}`);
  const active = getActiveWorker();
  const w = setWorkerIdentityValue(active.name, key as IdentitySetKey, value);
  console.log(pc.green(`Updated active worker ${w.name}.`));
  console.log(JSON.stringify(w.identity, null, 2));
});

program.command("sessions").description("List recent CrewCoder sessions.").action(async () => printSessions());
program.command("remember").argument("<fact...>").option("--topic <topic>", "Group the note under a topic file (default: memory)").description("Persist a durable fact to repo-shareable cross-session memory (.crewcoder/memory).").action((factParts: string[], options: { topic?: string }) => {
  const entry = rememberFact(process.cwd(), factParts.join(" "), { topic: options.topic });
  console.log(pc.green(`Remembered under "${entry.topic}" (id ${entry.id}).`));
  console.log(pc.gray(`  ${entry.file}`));
});
const memory = program.command("memory").description("Inspect and manage cross-session repo memory (.crewcoder/memory).");
memory.command("on").description("Enable memory for the current project only.").action(() => {
  const file = setProjectMemoryEnabled(process.cwd(), true);
  console.log(pc.green(`Project memory enabled.`));
  console.log(pc.gray(`  ${file}`));
});
memory.command("off").description("Disable memory reads and writes for the current project only.").action(() => {
  const file = setProjectMemoryEnabled(process.cwd(), false);
  console.log(pc.yellow(`Project memory disabled. Existing facts were preserved.`));
  console.log(pc.gray(`  ${file}`));
});
memory.command("status").option("--json", "Output raw JSON").description("Show whether memory is enabled for this project.").action((options: { json?: boolean }) => {
  const status = { enabled: isProjectMemoryEnabled(process.cwd()), settingsPath: resolveMemorySettingsPath(process.cwd()), memoryDir: resolveMemoryDir(process.cwd()) };
  if (options.json) { console.log(JSON.stringify(status, null, 2)); return; }
  console.log(`Project memory: ${status.enabled ? pc.green("on") : pc.yellow("off")}`);
  console.log(pc.gray(`  settings: ${status.settingsPath}`));
  console.log(pc.gray(`  memory: ${status.memoryDir}`));
});
memory.command("list", { isDefault: true }).option("--json", "Output raw JSON").description("List remembered facts.").action((options: { json?: boolean }) => {
  const entries = listMemories(process.cwd());
  if (options.json) { console.log(JSON.stringify(entries, null, 2)); return; }
  if (!entries.length) { console.log(pc.yellow(`No memory found in ${resolveMemoryDir(process.cwd())}.`)); return; }
  for (const entry of entries) {
    console.log(`${pc.cyan(entry.id)} ${pc.gray(`[${entry.topic}]`)} ${entry.text}`);
  }
});
memory.command("show").option("--json", "Output raw JSON").description("Show the memory context as injected into the system prompt.").action((options: { json?: boolean }) => {
  const context = readMemoryContext(process.cwd());
  if (options.json) { console.log(JSON.stringify({ context }, null, 2)); return; }
  console.log(context ?? pc.yellow("No memory recorded for this repo."));
});
memory.command("forget").argument("<id>").description("Remove a remembered fact by id.").action((id: string) => {
  const removed = forgetMemory(process.cwd(), id);
  if (!removed) { console.log(pc.yellow(`No memory entry with id ${id}.`)); process.exitCode = 1; return; }
  console.log(pc.yellow(`Forgot ${removed.id}: ${removed.text}`));
});
memory.command("path").description("Print the repo memory directory.").action(() => {
  console.log(resolveMemoryDir(process.cwd()));
});
program.command("audit").description("Read the append-only CrewCoder audit log.").option("--since <time>", "ISO timestamp or relative duration like 30m, 2h, 7d").option("--json", "Output raw JSON array").action(async (options: { since?: string; json?: boolean }) => {
  const since = options.since ? parseSinceOption(options.since) : undefined;
  const entries = await readAuditLog({ since });
  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (!entries.length) {
    console.log(pc.yellow(`No audit entries found in ${getAuditLogPath()}.`));
    return;
  }
  for (const entry of entries) {
    const target = entry.path ? ` ${entry.path}` : entry.toolName ? ` ${entry.toolName}` : "";
    const status = entry.type === "approval" ? ` approved=${entry.approved}` : entry.isError !== undefined ? ` error=${entry.isError}` : "";
    console.log(`${entry.timestamp} ${pc.cyan(entry.type)}${target}${status}`);
    if (entry.reason) console.log(pc.gray(`  reason: ${entry.reason}`));
    if (entry.sessionId) console.log(pc.gray(`  session: ${entry.sessionId}`));
  }
});
type CostOptions = {
  today?: boolean;
  since?: string;
  byModel?: boolean;
  byProvider?: boolean;
  byWorker?: boolean;
  bySession?: boolean;
  byDay?: boolean;
  session?: string;
  worker?: string;
  model?: string;
  provider?: string;
  json?: boolean;
};

const cost = program.command("cost").description("Token cost ledger: USD spend and full token usage per model, worker, session, or day.");
cost.command("show", { isDefault: true })
  .description("Summarize recorded model spend and token usage.")
  .option("--today", "Only usage recorded since local midnight")
  .option("--since <time>", "ISO timestamp or relative duration like 30m, 2h, 7d")
  .option("--by-model", "Group by provider:model (default)")
  .option("--by-provider", "Group by provider")
  .option("--by-worker", "Group by worker identity")
  .option("--by-session", "Group by session id")
  .option("--by-day", "Group by calendar day (UTC)")
  .option("--session <id>", "Only this session")
  .option("--worker <name>", "Only this worker")
  .option("--model <id>", "Only this model")
  .option("--provider <id>", "Only this provider")
  .option("--json", "Output raw JSON")
  .action(async (options: CostOptions) => {
    if (options.today && options.since) throw new Error("Use either --today or --since, not both.");
    const since = options.today ? startOfToday() : options.since ? parseSinceOption(options.since) : undefined;
    const entries = await readCostLedger({
      since,
      sessionId: options.session,
      worker: options.worker,
      model: options.model,
      providerId: options.provider
    });
    const report = summarizeCosts(entries, resolveCostGroupBy(options));

    if (options.json) {
      console.log(JSON.stringify({ ledger: getCostLedgerPath(), since: since?.toISOString(), ...report }, null, 2));
      return;
    }
    if (!entries.length) {
      console.log(pc.yellow(`No cost entries recorded in ${getCostLedgerPath()}.`));
      return;
    }

    const scope = since ? ` since ${since.toISOString()}` : "";
    console.log(pc.bold(`Total ${formatUsd(report.total.costUsd)}${scope}`));
    console.log(formatCostTokens(report.total));
    if (report.total.unpricedTurns) {
      console.log(pc.yellow(`${report.total.unpricedTurns} turn(s) had no known price and are excluded from the dollar total.`));
      console.log(pc.gray("Set a rate with: crewcoder cost price <provider:model> --input <usd/1M> --output <usd/1M>"));
    }
    console.log("");
    console.log(pc.gray(`by ${report.groupBy}`));
    for (const group of report.groups) {
      console.log(`${pc.cyan(group.key)} ${pc.bold(formatGroupCost(group))}`);
      console.log(pc.gray(`  ${formatCostTokens(group)}`));
    }
  });
cost.command("price")
  .argument("<key>", "provider:model (for example codex:gpt-5.6-luna) or a bare model id")
  .description("Set a USD-per-million-token rate override used by the cost ledger.")
  .requiredOption("--input <usd>", "Input tokens, USD per million")
  .requiredOption("--output <usd>", "Output tokens, USD per million")
  .option("--cache-read <usd>", "Cached input tokens, USD per million (defaults to the input rate)")
  .option("--cache-write <usd>", "Cache-write tokens, USD per million (Anthropic-style providers)")
  .action((key: string, options: { input: string; output: string; cacheRead?: string; cacheWrite?: string }) => {
    const entry: ModelPriceEntry = {
      inputPerMillionUsd: parseUsdRate(options.input, "--input"),
      outputPerMillionUsd: parseUsdRate(options.output, "--output"),
      ...(options.cacheRead === undefined ? {} : { cacheReadPerMillionUsd: parseUsdRate(options.cacheRead, "--cache-read") }),
      ...(options.cacheWrite === undefined ? {} : { cacheWritePerMillionUsd: parseUsdRate(options.cacheWrite, "--cache-write") })
    };
    const current = readConfig();
    writeConfig({ ...current, modelPricing: { ...current.modelPricing, [key.trim()]: entry } });
    console.log(pc.green(`Priced ${key.trim()}: $${entry.inputPerMillionUsd}/1M in, $${entry.outputPerMillionUsd}/1M out.`));
    console.log(pc.gray("Applies to turns recorded from now on; existing ledger entries keep their recorded cost."));
  });
cost.command("path").description("Print the cost ledger path.").action(() => {
  console.log(getCostLedgerPath());
});

function resolveCostGroupBy(options: CostOptions): CostGroupBy {
  if (options.byWorker) return "worker";
  if (options.bySession) return "session";
  if (options.byProvider) return "provider";
  if (options.byDay) return "day";
  return "model";
}

/** A fully unpriced group must not render as `$0.00`; free and unknown are different facts. */
function formatGroupCost(totals: CostTotals): string {
  if (totals.unpricedTurns === totals.turns) return "unpriced";
  const suffix = totals.unpricedTurns ? ` (+${totals.unpricedTurns} unpriced)` : "";
  return `${formatUsd(totals.costUsd)}${suffix}`;
}

function formatCostTokens(totals: CostTotals): string {
  const parts = [
    `${totals.turns} ${totals.turns === 1 ? "turn" : "turns"}`,
    `in ${totals.inputTokens.toLocaleString("en-US")}`,
    `cached ${totals.cachedInputTokens.toLocaleString("en-US")}`,
    `cache-write ${totals.cacheWriteTokens.toLocaleString("en-US")}`,
    `out ${totals.outputTokens.toLocaleString("en-US")}`,
    `reasoning ${totals.reasoningTokens.toLocaleString("en-US")}`,
    `total ${totals.totalTokens.toLocaleString("en-US")}`
  ];
  return parts.join(" | ");
}

function parseUsdRate(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number of USD per million tokens.`);
  return parsed;
}

const systemPrompt = program.command("system-prompt").alias("system-prompts").description(`Manage custom system prompts in ${resolveSystemPromptsDir()}.`);
systemPrompt.command("list", { isDefault: true }).option("--json", "Output raw JSON").description("List saved custom system prompts.").action((options: { json?: boolean }) => {
  const prompts = listSystemPrompts();
  if (options.json) {
    console.log(JSON.stringify(prompts.map((prompt) => ({ name: prompt.name, path: prompt.path })), null, 2));
    return;
  }
  if (!prompts.length) { console.log(pc.yellow(`No system prompts found in ${resolveSystemPromptsDir()}.`)); return; }
  for (const prompt of prompts) {
    console.log(`${pc.cyan(prompt.name)} ${pc.gray(prompt.path)}`);
  }
});
systemPrompt.command("save").argument("<name>").argument("[content...]", "Prompt content. Use --file for multiline files.").option("--file <path>", "Read prompt content from a markdown file.").description("Save a custom system prompt profile.").action((name: string, contentParts: string[] | undefined, options: { file?: string }) => {
  const content = options.file ? fs.readFileSync(path.resolve(options.file), "utf8") : (contentParts ?? []).join(" ");
  if (!content.trim()) throw new Error("Provide prompt content or --file <path>.");
  const saved = saveSystemPrompt(name, content);
  console.log(pc.green(`Saved system prompt ${saved.name}.`));
  console.log(pc.gray(saved.path));
});
systemPrompt.command("show").argument("<name>").option("--json", "Output raw JSON").description("Show a saved custom system prompt.").action((name: string, options: { json?: boolean }) => {
  const prompt = getSystemPrompt(name);
  if (options.json) { console.log(JSON.stringify(prompt, null, 2)); return; }
  console.log(`${pc.cyan(prompt.name)}\n${pc.gray(prompt.path)}\n\n${prompt.content}`);
});
systemPrompt.command("path").argument("[name]").description("Print the system prompts directory or one prompt file path.").action((name?: string) => {
  console.log(name ? getSystemPrompt(name).path : resolveSystemPromptsDir());
});
const promptCommand = program.command("command").alias("commands").description(`Manage reusable prompt commands in ${resolvePromptCommandsDir()}.`);
promptCommand.command("list", { isDefault: true }).option("--json", "Output raw JSON").description("List saved and extension prompt commands.").action(async (options: { json?: boolean }) => {
  const commands = await listAvailablePromptCommands();
  if (options.json) {
    console.log(JSON.stringify(commands.map((command) => ({ name: command.name, path: command.path, source: command.source, extensionId: command.extensionId, title: command.title, description: command.description, arguments: command.arguments ?? [] })), null, 2));
    return;
  }
  if (!commands.length) { console.log(pc.yellow(`No prompt commands found in ${resolvePromptCommandsDir()} or enabled extensions.`)); return; }
  for (const command of commands) {
    const source = command.source === "extension" ? pc.magenta("extension") : pc.green("local");
    console.log(`${pc.cyan(command.name)} ${source} ${pc.gray(command.path)}`);
    if (command.description) console.log(pc.gray(`  ${command.description}`));
  }
});
promptCommand.command("save").argument("<name>").argument("[content...]", "Prompt content. Use --file for multiline files.").option("--file <path>", "Read command content from a markdown file.").description("Save a reusable prompt command.").action((name: string, contentParts: string[] | undefined, options: { file?: string }) => {
  const content = options.file ? fs.readFileSync(path.resolve(options.file), "utf8") : (contentParts ?? []).join(" ");
  if (!content.trim()) throw new Error("Provide command content or --file <path>.");
  const saved = savePromptCommand(name, content);
  console.log(pc.green(`Saved prompt command ${saved.name}.`));
  console.log(pc.gray(saved.path));
});
promptCommand.command("show").argument("<name>").option("--json", "Output raw JSON").option("--arg <key=value...>", "Render command argument values.").description("Show a saved or extension prompt command.").action(async (name: string, options: { json?: boolean; arg?: string[] }) => {
  const command = await getAvailablePromptCommand(name, parsePromptCommandArgs(options.arg));
  if (options.json) { console.log(JSON.stringify(command, null, 2)); return; }
  const source = command.source === "extension" ? `extension: ${command.extensionId}` : "local";
  const missing = command.missingArguments?.length ? `\n${pc.yellow(`Missing required args: ${command.missingArguments.join(", ")}`)}` : "";
  console.log(`${pc.cyan(command.name)} (${source})\n${pc.gray(command.path)}${missing}\n\n${command.content}`);
});
promptCommand.command("path").argument("[name]").description("Print the prompt commands directory or one command file path.").action(async (name?: string) => {
  console.log(name ? (await getAvailablePromptCommand(name)).path : resolvePromptCommandsDir());
});
promptCommand.command("run").argument("<name>").argument("[args...]", "Raw command arguments passed to CrewCoderExtAPI command handlers.").description("Run an executable CrewCoderExtAPI command.").action(async (name: string, args: string[]) => {
  const result = await runAvailablePromptCommand(name, args.join(" "), process.cwd());
  for (const notification of result.notifications) {
    const prefix = notification.level === "info" ? "" : `${notification.level}: `;
    const text = `${prefix}${notification.message}`;
    if (notification.level === "error") console.error(pc.red(text));
    else if (notification.level === "warning") console.log(pc.yellow(text));
    else if (notification.level === "success") console.log(pc.green(text));
    else console.log(text);
  }
});
program.command("task").description("Manage tasks persistent project tasks.").argument("[action]").argument("[args...]", "Task command arguments").action((action: string | undefined, args: string[]) => {
  console.log(runCrewTaskCommand(action, args));
});
program.command("config").argument("<action>", "show or set").argument("[key]").argument("[value]").action((action: string, key: string | undefined, value: string | undefined) => {
  if (action === "show") {
    console.log(JSON.stringify(readConfig(), null, 2));
    return;
  }
  if (action !== "set") throw new Error("Supported actions: show, set.");
  if (!key || value === undefined) throw new Error("Usage: config set <key> <value>");
  const allowed = ["defaultMode", "defaultProvider", "defaultModel", "maxIterations", "stallDetection", "stallRepeatThreshold", "stallErrorThreshold", "allowExtensionTools", "allowExtensionHooks", "allowExtensionModules", "allowExtensionLiveUi", "disabledExtensions", "trustedExtensions", "sandboxedExtensions", "sandboxAllowedHosts", "sandboxNetworkIsolation", "checkpointsEnabled", "autoCompact", "autoCompactThresholdTokens", "compactionPreview", "goals.maxTurns", "goals.checkModel", "goals.timeoutMinutes"] as const;
  if (!allowed.includes(key as typeof allowed[number])) throw new Error(`Supported keys: ${allowed.join(", ")}`);
  const config = setConfigValue(key as typeof allowed[number], value);
  console.log(JSON.stringify(config, null, 2));
});
program.command("skill").alias("skills").argument("[action]", "list (default), show <name>", "list").argument("[id]").option("--json", "Output as JSON for TUI/automation consumers.").description(`List or show on-demand user skills from ${resolveSkillsDir()}.`).action((action: string, id: string | undefined, options: { json?: boolean }) => {
  const skills = loadFilesystemSkills();
  if (action === "list") {
    if (options.json) { console.log(JSON.stringify(skills.map(({ name, description, path }) => ({ name, description, path })), null, 2)); return; }
    if (!skills.length) { console.log(pc.yellow(`No skills found in ${resolveSkillsDir()}.`)); return; }
    for (const skill of skills) console.log(`${pc.cyan(skill.name)} - ${skill.description}`);
    return;
  }
  if ((action === "show" || action === "explain") && id) {
    const skill = findFilesystemSkill(id);
    if (!skill) throw new Error(`Unknown skill: ${id}`);
    if (options.json) { console.log(JSON.stringify(skill, null, 2)); return; }
    console.log(`${pc.cyan(skill.name)} - ${skill.description}\n${pc.gray(skill.path)}\n\n${skill.body}`);
    return;
  }
  throw new Error("Use: skill list [--json] OR skill show <name>");
});
program.command("docs").argument("<action>").argument("<query...>").action((action: string, queryParts: string[]) => {
  if (action !== "query") throw new Error("Only docs query is supported.");
  const query = queryParts.join(" ");
  const effectiveProfile = resolveIntegrationProfile(process.cwd(), readConfig());
  // Standalone keeps CrewCode plugin knowledge out of discovery and model context.
  const pluginMatches = effectiveProfile === "crewcode" ? queryCrewCodeDocs(query) : [];
  const extensionMatches = queryCrewCoderExtensionDocs(query);
  if (!pluginMatches.length && !extensionMatches.length) console.log(pc.yellow("No embedded docs matched."));
  if (pluginMatches.length) {
    console.log(pc.bold("CrewCode app plugins"));
    for (const doc of pluginMatches) console.log(`${pc.cyan(doc.title)}\n${doc.summary}\n`);
  }
  if (extensionMatches.length) {
    console.log(pc.bold("CrewCoder extensions"));
    for (const doc of extensionMatches) console.log(`${pc.cyan(doc.title)}\n${doc.summary}\n`);
  }
});
program.command("doctor").action(async () => {
  const home = ensureCrewCoderHome(); const providers = await listProviders(); const config = readConfig();
  const effectiveProfile = resolveIntegrationProfile(process.cwd(), config);
  console.log(pc.green("CrewCoder doctor"));
  console.log(`cwd: ${process.cwd()}`); console.log(`home: ${home.root}`); console.log(`home source: ${home.source}`); console.log(`config: ${home.configPath}`); console.log(`sessions: ${home.sessionsDir}`); console.log(`extensions: ${home.extensionsDir}`); console.log(`systemPrompts: ${home.systemPromptsDir}`); console.log(`integrationProfile: ${effectiveProfile}`); console.log(`defaultMode: ${config.defaultMode}`); console.log(`defaultProvider: ${config.defaultProvider}`); console.log(`providers: ${providers.map(p => p.id).join(", ")}`);
  for (const provider of providers) console.log(`  - ${provider.id}: ${provider.endpoint ?? provider.command} (${listProviderModelIds(provider).join(", ")})`);
  if (effectiveProfile === "crewcode") {
    const repo = discoverCrewCodeRepo(process.cwd());
    console.log(`CrewCode root: ${repo.root ?? "(not found)"}`); console.log(`examples/plugins: ${repo.examplesPluginsPath ?? "(not found)"}`);
  }
});

async function runPrompt(prompt: string, options: RunOptions) {
  try {
    await executeRunPrompt(prompt, options);
  } catch (error) {
    if (!options.ci) throw error;
    const summary = createCiErrorSummary(error);
    console.error(summary.failure?.message ?? summary.summary);
    console.log(JSON.stringify(summary));
    process.exitCode = summary.exitCode;
  }
}

async function executeRunPrompt(prompt: string, options: RunOptions) {
  if (options.ci && options.jsonEvents) throw new Error("--ci cannot be combined with --json-events because both own stdout");
  if (options.ci && options.replay) throw new Error("--ci cannot be combined with --replay");
  if (options.at && !options.replay) throw new Error("--at requires --replay <sessionId>");
  if (options.replay) {
    const source = await loadSession(options.replay);
    const turn = Number(options.at ?? "1");
    if (!Number.isInteger(turn) || turn < 1) throw new Error("--at must be a positive integer");
    const providerId = options.provider ?? source.provider ?? readConfig().defaultProvider;
    const model = options.model ?? source.model ?? readConfig().defaultModel;
    const jsonSink = options.jsonEvents ? createJsonEventSink() : undefined;
    const debug = createBackendDebugLogger({ emit: jsonSink, stderr: shouldDebugToStderr(options), runId: `replay-${source.id}-${turn}-${Date.now()}` });
    const result = await replaySessionTurn({ sessionId: source.id, turn, providerId, model, modelClient: options.heuristic ? createModelClientFromEnv() : new ProviderModelClient(providerId, source.cwd, model, debug, normalizeEffortOption(options.effort)), emit: jsonSink });
    if (!options.jsonEvents) console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!prompt.trim()) throw new Error("A prompt is required unless --replay is used");
  const config = readConfig();
  const externalDirectories = await validateExternalDirectories(process.cwd(), options.addDir);
  const requestedMode = normalizeMode(options.mode ?? config.defaultMode);
  const providerId = options.provider ?? process.env.CREWCODER_PROVIDER ?? config.defaultProvider;
  const model = options.model ?? process.env.CREWCODER_MODEL ?? config.defaultModel;
  const effort = normalizeEffortOption(options.effort);
  const maxIterations = Number(options.maxIterations ?? config.maxIterations);
  const jsonEvents = Boolean(options.jsonEvents);
  const jsonSink = jsonEvents ? createJsonEventSink() : undefined;
  const debug = createBackendDebugLogger({ emit: jsonSink, stderr: shouldDebugToStderr(options), runId: `run-${Date.now()}` });
  await debug.event({ level: "info", source: "cli", message: "backend debug logger initialized", details: { logPath: debug.logPath, jsonEvents, stderr: shouldDebugToStderr(options) } });
  const manualCompactSignal = { requested: false, preview: false };
  const compactionPreviewSignal = { decisions: [] as CompactionPreviewDecision[] };
  const followUpSignal = { messages: [] as string[] };
  const approvalSignal = { decisions: [] as Array<{ approvalId: string; approved: boolean; reason?: string }> };
  const uiBridge = createExtensionUiBridge({ emit: jsonSink, hasUI: jsonEvents });
  const detachControl = jsonEvents ? attachStdinControlListener({
    onCompact: (opts) => { manualCompactSignal.requested = true; if (opts.preview) manualCompactSignal.preview = true; },
    onCompactPreviewDecision: (decision) => { compactionPreviewSignal.decisions.push(decision); },
    onFollowUp: (message) => { followUpSignal.messages.push(message); },
    onApprovalDecision: (decision) => { approvalSignal.decisions.push(decision); },
    onUiResponse: (response) => { uiBridge.resolveResponse(response.requestId, response.value); }
  }) : undefined;
  const contextWindow = (await resolveModel(providerId, model))?.metadata?.contextWindow;
  try {
    const response = await runAgentLoop({ prompt, requestedMode, cwd: process.cwd(), externalDirectories, images: options.image }, {
      providerId,
      model,
      effort,
      contextWindow,
      maxIterations,
      approvalMode: normalizeApprovalMode(options.approval ?? "never"),
      modelClient: options.heuristic ? undefined : new ProviderModelClient(providerId, process.cwd(), model, debug, effort),
      dumpModelInput: shouldDumpModelInput(options),
      systemPromptName: options.systemPrompt,
      workerName: options.worker,
      tokenBudget: resolveTokenBudget(options),
      verify: Boolean(options.verify || options.ci),
      parentSessionId: options.parentSession,
      manualCompactSignal,
      compactionPreviewSignal,
      followUpSignal,
      approvalSignal: jsonEvents ? approvalSignal : undefined,
      uiBridge,
      emit: jsonSink ?? (async (event) => {
        const write = options.ci ? console.error : console.log;
        if (event.type === "tool_execution_start") write(pc.gray(`tool:start ${event.toolName}`));
        if (event.type === "tool_execution_end") write(event.isError ? pc.red(`tool:error ${event.toolName}`) : pc.gray(`tool:end ${event.toolName}`));
        if (event.type === "approval_required") write(pc.yellow(`approval required: ${event.reason}`));
      })
    });
    if (options.ci) {
      const summary = createCiRunSummary(response);
      console.log(JSON.stringify(summary));
      process.exitCode = summary.exitCode;
    } else {
      if (!jsonEvents) printRunResult(response, providerId, model);
      if (response.providerError || response.stallError || response.iterationCapReached) process.exitCode = 1;
    }
  } finally {
    uiBridge.cancelAll();
    detachControl?.();
  }
}

async function runCrewPrompt(prompt: string, options: RunOptions & { workers: string; json?: boolean }) {
  await runCrewPromptWithWorkers(prompt, parseWorkerList(options.workers), options, undefined, "crew");
}

async function runCrewTeam(teamId: string, prompt: string, options: RunOptions & { json?: boolean }) {
  const team = resolveWorkerTeam(teamId, process.cwd());
  const workerPrompts = Object.fromEntries(team.roles.map((role) => [role.worker, buildTeamPrompt(team, prompt, role)]));
  await runCrewPromptWithWorkers(prompt, teamWorkerNames(team), options, workerPrompts, `team:${team.id}`);
}

async function runCrewPromptWithWorkers(prompt: string, workers: string[], options: RunOptions & { json?: boolean }, workerPrompts: Record<string, string> | undefined, label: string) {
  const config = readConfig();
  const requestedMode = normalizeMode(options.mode ?? config.defaultMode);
  const providerId = options.provider ?? process.env.CREWCODER_PROVIDER ?? config.defaultProvider;
  const model = options.model ?? process.env.CREWCODER_MODEL ?? config.defaultModel;
  const maxIterations = Number(options.maxIterations ?? config.maxIterations);
  const jsonEvents = Boolean(options.jsonEvents);
  const jsonSink = jsonEvents ? createJsonEventSink() : undefined;
  const debug = createBackendDebugLogger({ emit: jsonSink, stderr: shouldDebugToStderr(options), runId: `${label}-run-${Date.now()}` });
  await debug.event({ level: "info", source: "cli", message: `${label} run backend debug logger initialized`, details: { logPath: debug.logPath, jsonEvents, stderr: shouldDebugToStderr(options) } });
  const contextWindow = (await resolveModel(providerId, model))?.metadata?.contextWindow;
  const result = await runWorkerCrew({ prompt, workers, workerPrompts, requestedMode, cwd: process.cwd() }, {
    providerId,
    model,
    contextWindow,
    maxIterations,
    approvalMode: normalizeApprovalMode(options.approval ?? "never"),
    dumpModelInput: shouldDumpModelInput(options),
    systemPromptName: options.systemPrompt,
    createModelClient: () => options.heuristic ? undefined : new ProviderModelClient(providerId, process.cwd(), model, debug, normalizeEffortOption(options.effort)),
    emit: jsonSink ?? (async (event) => {
      if (event.type === "tool_execution_start") console.log(pc.gray(`tool:start ${event.toolName}`));
      if (event.type === "tool_execution_end") console.log(event.isError ? pc.red(`tool:error ${event.toolName}`) : pc.gray(`tool:end ${event.toolName}`));
      if (event.type === "approval_required") console.log(pc.yellow(`approval required: ${event.reason}`));
    })
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(pc.bold(`Crew run complete: ${result.workers.length} worker${result.workers.length === 1 ? "" : "s"}`));
  for (const worker of result.workers) {
    console.log(`${pc.cyan(worker.worker)} ${pc.gray(worker.sessionId)}`);
    console.log(worker.summary);
    if (worker.mutationLog.length) console.log(pc.gray(`  changed: ${[...new Set(worker.mutationLog)].join(", ")}`));
  }
}

async function runCrewHandoff(workerRef: string, sessionId: string, prompt: string, options: RunOptions & { json?: boolean }) {
  const config = readConfig();
  const providerId = options.provider ?? process.env.CREWCODER_PROVIDER ?? config.defaultProvider;
  const model = options.model ?? process.env.CREWCODER_MODEL ?? config.defaultModel;
  const maxIterations = Number(options.maxIterations ?? config.maxIterations);
  const requestedMode = options.mode ? normalizeMode(options.mode) : undefined;
  const jsonEvents = Boolean(options.jsonEvents);
  const jsonSink = jsonEvents ? createJsonEventSink() : undefined;
  const debug = createBackendDebugLogger({ emit: jsonSink, stderr: shouldDebugToStderr(options), runId: `crew-handoff-${sessionId}-${Date.now()}` });
  await debug.event({ level: "info", source: "cli", message: "crew handoff backend debug logger initialized", details: { logPath: debug.logPath, jsonEvents, stderr: shouldDebugToStderr(options) } });
  const contextWindow = (await resolveModel(providerId, model))?.metadata?.contextWindow;
  const result = await handoffToWorker({ sessionId, workerRef, prompt, requestedMode, cwd: process.cwd() }, {
    providerId,
    model,
    contextWindow,
    maxIterations,
    approvalMode: normalizeApprovalMode(options.approval ?? "never"),
    dumpModelInput: shouldDumpModelInput(options),
    systemPromptName: options.systemPrompt,
    createModelClient: () => options.heuristic ? undefined : new ProviderModelClient(providerId, process.cwd(), model, debug, normalizeEffortOption(options.effort)),
    emit: jsonSink ?? (async (event) => {
      if (event.type === "tool_execution_start") console.log(pc.gray(`tool:start ${event.toolName}`));
      if (event.type === "tool_execution_end") console.log(event.isError ? pc.red(`tool:error ${event.toolName}`) : pc.gray(`tool:end ${event.toolName}`));
      if (event.type === "approval_required") console.log(pc.yellow(`approval required: ${event.reason}`));
    })
  });
  if (options.json) {
    console.log(JSON.stringify({ sourceSessionId: result.sourceSessionId, worker: result.worker, sessionId: result.sessionId, summary: result.summary, mutationLog: result.mutationLog }, null, 2));
    return;
  }
  console.log(pc.green(`Handed off ${result.sourceSessionId} -> ${result.sessionId} as ${result.worker}.`));
  console.log(result.summary);
  if (result.sessionFile) console.log(pc.gray(`Session: ${result.sessionFile}`));
}

async function appendCheckpointRestoreAudit(
  sessionId: string,
  audit: NonNullable<SessionRecord["checkpointRestores"]>[number],
  event: SessionRecord["events"][number]
): Promise<void> {
  try {
    const record = await loadSession(sessionId);
    await saveSession({
      ...record,
      events: [...record.events, event],
      checkpointRestores: [...(record.checkpointRestores ?? []), audit]
    });
  } catch {}
}

function printGoal(goal: GoalRecord, json = false): void {
  if (json) { console.log(JSON.stringify(goal, null, 2)); return; }
  const color = goal.status === "completed" ? pc.green : goal.status === "failed" || goal.status === "cancelled" ? pc.red : goal.status === "paused" || goal.status === "awaiting_approval" ? pc.yellow : pc.cyan;
  console.log(`${color(goal.id)} ${pc.bold(goal.status)} · ${goal.provider}/${goal.model} · cycle ${goal.cycle}${goal.maxTurns ? `/${goal.maxTurns}` : ""}`);
  console.log(`  ${goal.objective}`);
  if (goal.checkModel) console.log(pc.gray(`  verifier: ${goal.provider}/${goal.checkModel}${goal.lastCheck ? ` · ${goal.lastCheck.verdict}: ${goal.lastCheck.reason}` : ""}`));
  if (goal.timeoutMinutes) console.log(pc.gray(`  timeout: ${goal.timeoutMinutes} minutes from initial start`));
  if (goal.sessionId) console.log(pc.gray(`  session: ${goal.sessionId}`));
  if (goal.pendingApproval) console.log(pc.yellow(`  approval: ${goal.pendingApproval.toolName} — ${goal.pendingApproval.reason}`));
  if (goal.pauseReason) console.log(pc.yellow(`  paused: ${goal.pauseReason}`));
  if (goal.error) console.log(pc.red(`  error: ${goal.error}`));
  if (goal.completionSummary) console.log(pc.green(`  completed: ${goal.completionSummary}`));
  if (goal.completionEvidence) console.log(pc.gray(`  evidence: ${goal.completionEvidence}`));
}

function printRunResult(response: Awaited<ReturnType<typeof runAgentLoop>>, providerId: string, model?: string) {
  console.log(pc.bold(`CrewCoder mode: ${response.mode}`));
  console.log(pc.bold(`Provider: ${providerId}${model ? ` / ${model}` : ""}`));
  if (response.providerError) console.error(pc.red(`Provider error (${providerId}${model ? ` / ${model}` : ""}): ${response.providerError}`));
  else if (response.stallError) console.error(pc.red(response.stallError));
  else console.log(response.summary);
  if (response.iterationCapReached) console.error(pc.yellow("Run was truncated by maxIterations; the task may be unfinished."));
  if (response.activatedSkills.length) { console.log(pc.cyan("\nActivated skills:")); for (const skill of response.activatedSkills) console.log(`  - ${skill}`); }
  if (response.retrievedDocs.length) { console.log(pc.cyan("\nAvailable docs:")); console.log(`  ${response.retrievedDocs.join(", ")}`); }
  if (response.mutationLog.length) { console.log(pc.cyan("\nChanged files:")); for (const file of [...new Set(response.mutationLog)]) console.log(`  - ${file}`); }
  if (response.usage.turns > 0) console.log(pc.cyan(`\nUsage: ${formatUsage(response.usage)}`));
  if (typeof response.usage.tokenBudget === "number") console.log(response.budgetExceeded ? pc.red(`Budget: exceeded ${response.usage.totalTokens ?? 0}/${response.usage.tokenBudget} tokens`) : pc.cyan(`Budget: ${response.usage.totalTokens ?? 0}/${response.usage.tokenBudget} tokens`));
  if (response.verification) console.log(response.verification.ok ? pc.green(`Verification: passed (${response.verification.checks.length} checks)`) : pc.red(`Verification: failed (${response.verification.checks.filter((check) => !check.ok).map((check) => check.title).join(", ")})`));
  if (response.sessionFile) console.log(pc.gray(`\nSession: ${response.sessionFile}`));
  if (response.notes.length) { console.log(pc.cyan("\nNotes:")); for (const note of response.notes) console.log(`  - ${note}`); }
}

async function printSessions(json = false) {
  // Summaries, never full records. Dumping whole SessionRecords here serialized
  // every message, event, and model turn — 268 MB of JSON for 13 sessions on a
  // real store — only for the caller to render six header fields from it.
  const sessions = await listSessionSummaries({ cwd: process.cwd() });
  if (json) { console.log(JSON.stringify(sessions.slice(0, 20), null, 2)); return; }
  if (!sessions.length) { console.log(pc.yellow("No sessions found.")); return; }
  for (const s of sessions.slice(0, 20)) {
    console.log(`${pc.cyan(s.id)} ${s.startedAt}`);
    console.log(`  mode: ${s.resolvedMode} provider: ${s.provider ?? "(none)"}`);
    console.log(`  prompt: ${s.prompt.slice(0, 100)}`);
  }
}

function formatUsage(usage: Awaited<ReturnType<typeof runAgentLoop>>["usage"]): string {
  const parts: string[] = [];
  if (typeof usage.totalTokens === "number") parts.push(`${usage.totalTokens.toLocaleString("en-US")} tokens`);
  if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") parts.push(`in ${usage.inputTokens ?? 0} / out ${usage.outputTokens ?? 0}`);
  if (typeof usage.cachedInputTokens === "number" && usage.cachedInputTokens > 0) parts.push(`cached ${usage.cachedInputTokens}`);
  if (typeof usage.reasoningTokens === "number" && usage.reasoningTokens > 0) parts.push(`reasoning ${usage.reasoningTokens}`);
  if (usage.turns > 1) parts.push(`${usage.turns} turns`);
  return parts.join(" · ") || "unavailable";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseGoalIntegerOption(value: string | undefined, fallback: number, name: string, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return parsed;
}

function normalizeMode(value: string): AgentMode { if (!isAgentMode(value)) throw new Error(`Mode must be one of: ${AGENT_MODE_LIST}`); return value; }
function normalizeApprovalMode(value: string): ApprovalMode { if (value === "never" || value === "review" || value === "always" || value === "full-access" || value === "sandboxed") return value; throw new Error("Approval mode must be one of: never, review, always, full-access, sandboxed"); }
function normalizeEffortOption(value?: string): string | undefined {
  if (!readConfig().thinkingEnabled) return "none";
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return process.env.CREWCODER_THINKING ?? process.env.CREWCODER_REASONING_EFFORT;
  if (normalized === "off") return "none";
  if (["none", "low", "medium", "high", "xhigh"].includes(normalized)) return normalized;
  throw new Error("Effort must be one of: none, low, medium, high, xhigh");
}
function resolveTokenBudget(options: RunOptions): number | undefined {
  if (options.budget !== undefined && options.maxTokens !== undefined && parseTokenBudget(options.budget) !== parseTokenBudget(options.maxTokens)) throw new Error("--budget and --max-tokens must match when both are provided");
  return parseTokenBudget(options.budget ?? options.maxTokens);
}
function shouldDebugToStderr(options: RunOptions): boolean { return Boolean(options.backendDebugStderr) || process.env.CREWCODER_BACKEND_DEBUG_STDERR === "1"; }
function shouldDumpModelInput(options: RunOptions): boolean { return Boolean(options.dumpModelInput) || process.env.CREWCODER_DUMP_MODEL_INPUT === "1"; }
function parseSinceOption(value: string): Date {
  const trimmed = value.trim();
  const relative = /^(\d+)(m|h|d)$/i.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - amount * multiplier);
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) throw new Error("--since must be an ISO timestamp or relative duration like 30m, 2h, 7d");
  return new Date(timestamp);
}
async function importProviderEnvKey(providerId: string): Promise<void> {
  const provider = (await listProviders()).find((item) => item.id === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (!provider.apiKeyEnv) throw new Error(`Provider ${providerId} does not declare an API-key environment variable.`);
  const key = process.env[provider.apiKeyEnv];
  if (!key) throw new Error(`Provider ${providerId} requires ${provider.apiKeyEnv} in the current environment. Start this command from a shell that can see the key.`);
  setAuthCredential(provider.id, { type: "api_key", key });
  setAuthCredential(provider.apiKeyEnv, { type: "api_key", key });
  console.log(pc.green(`Imported ${provider.apiKeyEnv} for ${provider.id}.`));
  console.log(pc.gray(`Auth saved to ${getAuthPath()}`));
}
if (process.argv.length === 2) {
  if (isStandaloneExecutable()) {
    program.outputHelp();
  } else {
    launchTui().catch((error) => {
      console.error(pc.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });
  }
} else {
  program.parseAsync(process.argv).catch((error) => {
    console.error(pc.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}

function launchTui(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("crewcoder-tui", [], { stdio: "inherit" });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error("CrewCoder TUI is not installed. Run: npm link -w @onpoint-dev-tools/crewcoder-tui"));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code && code !== 0) process.exitCode = code;
      resolve();
    });
  });
}
