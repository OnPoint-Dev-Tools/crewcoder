#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const agentPath = path.join(root, "crewcoder-agent", "package.json");
const sdkPath = path.join(root, "crewcoder-sdk", "package.json");
const clientPath = path.join(root, "crewcoder-client", "package.json");
const agent = JSON.parse(fs.readFileSync(agentPath, "utf8"));
const sdk = JSON.parse(fs.readFileSync(sdkPath, "utf8"));
const client = JSON.parse(fs.readFileSync(clientPath, "utf8"));
const publishing = process.argv.includes("--publish");
const failures = [];

if (agent.version !== sdk.version || client.version !== sdk.version) failures.push(`Version mismatch: agent=${agent.version}, client=${client.version}, sdk=${sdk.version}`);
if (sdk.dependencies?.[agent.name] !== agent.version) failures.push(`SDK dependency ${agent.name} must exactly match ${agent.version}.`);
if (sdk.dependencies?.[client.name] !== client.version) failures.push(`SDK dependency ${client.name} must exactly match ${client.version}.`);
if (agent.license !== "Apache-2.0" || sdk.license !== "Apache-2.0" || client.license !== "Apache-2.0") failures.push("Agent, client, and SDK must declare Apache-2.0.");
if (agent.engines?.node !== ">=22.0.0" || sdk.engines?.node !== ">=22.0.0") failures.push("Agent and SDK must require Node.js >=22.0.0.");
for (const packageDirectory of ["crewcoder-agent", "crewcoder-client", "crewcoder-sdk"]) {
  for (const file of ["LICENSE", "README.md"]) {
    if (!fs.existsSync(path.join(root, packageDirectory, file))) failures.push(`${packageDirectory}/${file} is missing.`);
  }
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
  if (agent.private === true || sdk.private === true || client.private === true) failures.push("Publishing is blocked while any package has private: true.");
  if (!agent.repository || !sdk.repository || !client.repository) failures.push("Publishing requires repository metadata in every package.");
}

if (failures.length) {
  console.error("SDK release metadata check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`SDK release metadata check passed for ${agent.version}${publishing ? " (publish mode)" : " (private dry-run mode)"}.`);
