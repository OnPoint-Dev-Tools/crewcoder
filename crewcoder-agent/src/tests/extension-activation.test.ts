import { describe, expect, it } from "vitest";
import {
  activateExtensionContributions,
  activatedContributionIds,
  formatExtensionActivation
} from "../extensions/extension-activation.js";
import type { LoadedCrewCoderExtension } from "../extensions/types.js";

function extension(partial: Partial<LoadedCrewCoderExtension["manifest"]> & { id: string }): LoadedCrewCoderExtension {
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

describe("extension prompt/skill activation", () => {
  const dockerExt = extension({
    id: "docker-pack",
    contributes: {
      skills: [
        { id: "compose", title: "Compose", description: "Write docker-compose files.", triggers: ["docker", "compose"], prompt: "Prefer multi-stage builds." },
        { id: "k8s", title: "Kubernetes", description: "Author k8s manifests.", triggers: ["kubernetes", "kubectl"], prompt: "Set resource limits." }
      ],
      promptPacks: [
        { id: "review", title: "Review Pack", prompts: [{ id: "security", title: "Security Review", content: "Check for leaked secrets." }] }
      ]
    }
  });

  it("activates a skill when a trigger matches the prompt", () => {
    const activation = activateExtensionContributions([dockerExt], "help me write a docker compose file");
    const compose = activation.skills.find((skill) => skill.id === "compose");
    const k8s = activation.skills.find((skill) => skill.id === "k8s");
    expect(compose?.activated).toBe(true);
    expect(k8s?.activated).toBe(false);
  });

  it("lists all enabled skills but only activated ids are reported", () => {
    const activation = activateExtensionContributions([dockerExt], "set up a docker container");
    expect(activation.skills).toHaveLength(2);
    expect(activatedContributionIds(activation)).toEqual(["docker-pack/compose"]);
  });

  it("activates a prompt-pack prompt when its title is referenced", () => {
    const activation = activateExtensionContributions([dockerExt], "run a security review on this");
    expect(activation.prompts).toHaveLength(1);
    expect(activation.prompts[0]?.content).toContain("leaked secrets");
    expect(activatedContributionIds(activation)).toContain("docker-pack/review/security");
  });

  it("does not activate prompt packs without a reference match", () => {
    const activation = activateExtensionContributions([dockerExt], "just say hello");
    expect(activation.prompts).toHaveLength(0);
  });

  it("renders activated instructions and omits inactive skill bodies", () => {
    const activation = activateExtensionContributions([dockerExt], "docker compose security review");
    const rendered = formatExtensionActivation(activation);
    expect(rendered).toContain("Available extension skills:");
    expect(rendered).toContain("docker-pack/compose (active)");
    expect(rendered).toContain("Prefer multi-stage builds.");
    expect(rendered).not.toContain("Set resource limits.");
    expect(rendered).toContain("Check for leaked secrets.");
  });

  it("returns an empty string to render when nothing is contributed", () => {
    const activation = activateExtensionContributions([extension({ id: "empty" })], "anything");
    expect(activation.skills).toHaveLength(0);
    expect(formatExtensionActivation(activation)).toBe("");
  });
});
