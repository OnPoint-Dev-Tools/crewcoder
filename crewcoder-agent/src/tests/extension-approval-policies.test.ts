import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../core/config.js";
import { evaluateExtensionApprovalPolicies, extensionApprovalPoliciesFromManifest, loadTrustedExtensionApprovalPolicies } from "../extensions/extension-approval-policies.js";
import type { LoadedCrewCoderExtension } from "../extensions/types.js";

function loadedExtension(partial: Partial<LoadedCrewCoderExtension["manifest"]> & { id: string }): LoadedCrewCoderExtension {
  return {
    dir: `/tmp/${partial.id}`,
    warnings: [],
    manifest: {
      id: partial.id,
      name: partial.name ?? partial.id,
      version: partial.version ?? "0.1.0",
      crewcoder: { apiVersion: "0.1" },
      contributes: partial.contributes
    }
  };
}

describe("extension approval policies", () => {
  it("normalizes manifest approval policies", () => {
    const policies = extensionApprovalPoliciesFromManifest(loadedExtension({
      id: "safety-pack",
      contributes: {
        approvalPolicies: [{ id: "env", title: "Protect env", action: "block", paths: [".env*"], reason: "Secrets are protected" }]
      }
    }));

    expect(policies).toEqual([{
      extensionId: "safety-pack",
      policyId: "env",
      title: "Protect env",
      action: "block",
      reason: "Secrets are protected",
      tools: [],
      paths: [".env*"],
      commands: []
    }]);
  });

  it("matches protected path and command policies", () => {
    const policies = extensionApprovalPoliciesFromManifest(loadedExtension({
      id: "safety-pack",
      contributes: {
        approvalPolicies: [
          { id: "env", title: "Protect env", action: "block", paths: [".env*"], reason: "Secrets are protected" },
          { id: "deploy", title: "Review deploy", action: "review", tools: ["bash"], commands: ["deploy"] }
        ]
      }
    }));

    expect(evaluateExtensionApprovalPolicies(policies, { type: "toolCall", id: "t1", name: "write", arguments: { path: ".env.local" } })).toMatchObject({ action: "block", risk: "dangerous" });
    expect(evaluateExtensionApprovalPolicies(policies, { type: "toolCall", id: "t2", name: "bash", arguments: { command: "npm run deploy" } })).toMatchObject({ action: "review", risk: "review" });
    expect(evaluateExtensionApprovalPolicies(policies, { type: "toolCall", id: "t3", name: "read", arguments: { path: "README.md" } })).toEqual({ action: "allow" });
  });

  it("matches workspace-relative policies against absolute tool paths when cwd is available", () => {
    const workspace = path.join(os.tmpdir(), "crewcoder-policy-workspace");
    const policies = extensionApprovalPoliciesFromManifest(loadedExtension({
      id: "safety-pack",
      contributes: {
        approvalPolicies: [{ id: "env", title: "Protect env", action: "block", paths: [".env*", "secrets/**"] }]
      }
    }));

    expect(evaluateExtensionApprovalPolicies(policies, {
      type: "toolCall",
      id: "t1",
      name: "write",
      arguments: { cwd: workspace, path: path.join(workspace, ".env.local") }
    })).toMatchObject({ action: "block" });
    expect(evaluateExtensionApprovalPolicies(policies, {
      type: "toolCall",
      id: "t2",
      name: "write",
      arguments: { cwd: workspace, path: path.join(workspace, "secrets", "token.txt") }
    })).toMatchObject({ action: "block" });
  });

  it("matches absolute path policies against absolute tool paths", () => {
    const workspace = path.join(os.tmpdir(), "crewcoder-policy-workspace");
    const policies = extensionApprovalPoliciesFromManifest(loadedExtension({
      id: "safety-pack",
      contributes: {
        approvalPolicies: [{ id: "workspace-env", title: "Protect workspace env", action: "block", paths: [path.join(workspace, ".env*")] }]
      }
    }));

    expect(evaluateExtensionApprovalPolicies(policies, {
      type: "toolCall",
      id: "t1",
      name: "write",
      arguments: { path: path.join(workspace, ".env.local") }
    })).toMatchObject({ action: "block" });
    expect(evaluateExtensionApprovalPolicies(policies, {
      type: "toolCall",
      id: "t2",
      name: "write",
      arguments: { path: path.join(os.tmpdir(), "other", ".env.local") }
    })).toEqual({ action: "allow" });
  });

  it("loads policies only when hook execution is allowed and extension is trusted", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-ext-policies-"));
    process.env.CREWCODER_HOME = home;
    try {
      const extensionDir = path.join(home, "extensions", "trusted-safety");
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
        id: "trusted-safety",
        name: "Trusted Safety",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        contributes: { approvalPolicies: [{ id: "env", title: "Protect env", action: "block", paths: [".env*"] }] }
      }), "utf8");

      expect(await loadTrustedExtensionApprovalPolicies()).toHaveLength(0);
      writeConfig({ ...readConfig(), allowExtensionHooks: true, trustedExtensions: ["trusted-safety"] });
      expect((await loadTrustedExtensionApprovalPolicies()).map((policy) => policy.policyId)).toEqual(["env"]);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });
});
