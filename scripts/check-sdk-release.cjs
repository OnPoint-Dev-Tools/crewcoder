#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const agentPath = path.join(root, "crewcoder-agent", "package.json");
const sdkPath = path.join(root, "crewcoder-sdk", "package.json");
const clientPath = path.join(root, "crewcoder-client", "package.json");
const tuiPath = path.join(root, "crewcoder-tui", "package.json");
const tuiCorePath = path.join(root, "crewcoder-tui-core", "package.json");
const openTuiPath = path.join(root, "crewcoder-opentui", "package.json");
const agent = JSON.parse(fs.readFileSync(agentPath, "utf8"));
const sdk = JSON.parse(fs.readFileSync(sdkPath, "utf8"));
const client = JSON.parse(fs.readFileSync(clientPath, "utf8"));
const tui = JSON.parse(fs.readFileSync(tuiPath, "utf8"));
const tuiCore = JSON.parse(fs.readFileSync(tuiCorePath, "utf8"));
const openTui = JSON.parse(fs.readFileSync(openTuiPath, "utf8"));
const publishing = process.argv.includes("--publish");
const failures = [];
const expectedRepositoryHost = "github.com/OnPoint-Dev-Tools/crewcoder";

function packageRepositoryUrl(manifest) {
  if (typeof manifest.repository === "string") return manifest.repository;
  if (manifest.repository && typeof manifest.repository.url === "string") return manifest.repository.url;
  return "";
}

if (agent.version !== sdk.version || client.version !== sdk.version) failures.push(`Version mismatch: agent=${agent.version}, client=${client.version}, sdk=${sdk.version}`);
if (sdk.dependencies?.[agent.name] !== agent.version) failures.push(`SDK dependency ${agent.name} must exactly match ${agent.version}.`);
if (sdk.dependencies?.[client.name] !== client.version) failures.push(`SDK dependency ${client.name} must exactly match ${client.version}.`);
if ([agent, sdk, client, tui, tuiCore, openTui].some((manifest) => manifest.license !== "Apache-2.0")) failures.push("Agent, client, SDK, TUI core, and both TUIs must declare Apache-2.0.");
for (const [label, manifest] of [["tui", tui], ["opentui", openTui]]) {
  if (manifest.dependencies?.[tuiCore.name] !== tuiCore.version) failures.push(`${label} dependency ${tuiCore.name} must exactly match ${tuiCore.version}.`);
}
if (tuiCore.engines?.node !== ">=22.0.0" || tui.engines?.node !== ">=22.0.0") failures.push("TUI core and the legacy TUI must require Node.js >=22.0.0.");
if (openTui.engines?.node !== ">=26.4.0") failures.push("crewcoder-opentui must declare the Node.js >=26.4.0 floor that the umbrella launcher enforces.");
if (agent.engines?.node !== ">=22.0.0" || sdk.engines?.node !== ">=22.0.0") failures.push("Agent and SDK must require Node.js >=22.0.0.");
for (const packageDirectory of ["crewcoder-agent", "crewcoder-client", "crewcoder-sdk", "crewcoder-tui", "crewcoder-tui-core", "crewcoder-opentui"]) {
  for (const file of ["LICENSE", "README.md"]) {
    if (!fs.existsSync(path.join(root, packageDirectory, file))) failures.push(`${packageDirectory}/${file} is missing.`);
  }
}
for (const [label, manifest] of [["agent", agent], ["client", client], ["sdk", sdk], ["tui", tui], ["tui-core", tuiCore], ["opentui", openTui]]) {
  const repositoryUrl = packageRepositoryUrl(manifest);
  if (!repositoryUrl) failures.push(`${label} package.json repository.url is missing.`);
  else if (!repositoryUrl.includes(expectedRepositoryHost)) failures.push(`${label} repository.url must point at ${expectedRepositoryHost}.`);
}
if (!fs.existsSync(path.join(root, "crewcoder-sdk", "CHANGELOG.md"))) failures.push("crewcoder-sdk/CHANGELOG.md is missing.");

const clientVersionSource = fs.readFileSync(path.join(root, "crewcoder-client", "src", "version.ts"), "utf8");
const clientVersionMatch = clientVersionSource.match(/CREWCODER_CLIENT_VERSION = "([^"]+)"/);
if (clientVersionMatch?.[1] !== client.version) failures.push(`CREWCODER_CLIENT_VERSION must equal package version ${client.version}.`);
const sdkVersionSource = fs.readFileSync(path.join(root, "crewcoder-sdk", "src", "version.ts"), "utf8");
const sdkVersionMatch = sdkVersionSource.match(/CREWCODER_SDK_VERSION = "([^"]+)"/);
if (sdkVersionMatch?.[1] !== sdk.version) failures.push(`CREWCODER_SDK_VERSION must equal package version ${sdk.version}.`);
const agentVersionSource = fs.readFileSync(path.join(root, "crewcoder-agent", "src", "core", "version.ts"), "utf8");
const agentVersionMatch = agentVersionSource.match(/CREWCODER_VERSION = "([^"]+)"/);
if (agentVersionMatch?.[1] !== agent.version) failures.push(`CREWCODER_VERSION must equal package version ${agent.version}.`);
const agentFleetSource = fs.readFileSync(path.join(root, "crewcoder-agent", "src", "core", "fleet-types.ts"), "utf8");
const clientFleetSource = fs.readFileSync(path.join(root, "crewcoder-client", "src", "client.ts"), "utf8");
const agentFleetVersion = agentFleetSource.match(/FLEET_PROTOCOL_VERSION = "([^"]+)"/)?.[1];
const clientFleetVersion = clientFleetSource.match(/CREWCODER_FLEET_PROTOCOL_VERSION = "([^"]+)"/)?.[1];
if (!agentFleetVersion || agentFleetVersion !== clientFleetVersion) failures.push(`Fleet protocol version mismatch: agent=${agentFleetVersion ?? "missing"}, client=${clientFleetVersion ?? "missing"}.`);

if (publishing) {
  const published = [agent, sdk, client, tui, tuiCore, openTui];
  if (published.some((manifest) => manifest.private === true)) failures.push("Publishing is blocked while any package has private: true.");
  if (published.some((manifest) => !manifest.repository)) failures.push("Publishing requires repository metadata in every package.");
}

if (failures.length) {
  console.error("SDK release metadata check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`SDK release metadata check passed for ${agent.version}${publishing ? " (publish mode)" : " (private dry-run mode)"}.`);
