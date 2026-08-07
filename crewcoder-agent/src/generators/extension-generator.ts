import fs from "node:fs/promises";
import path from "node:path";
import { ensureCrewCoderHome } from "../core/crewcoder-home.js";
import type { CrewCoderExtensionManifest } from "../extensions/types.js";

function titleFromId(id: string): string { return id.split(/[-_\s]+/).filter(Boolean).map(p => p[0]?.toUpperCase()+p.slice(1)).join(" "); }

export async function createCrewCoderExtension(id: string): Promise<string[]> {
  const home = ensureCrewCoderHome();
  const dir = path.join(home.extensionsDir, id);
  await fs.mkdir(dir, { recursive: true });
  const manifest = buildManifest(id);
  await fs.writeFile(path.join(dir, "crewcoder.extension.json"), JSON.stringify(manifest, null, 2)+"\n");
  await fs.writeFile(path.join(dir, "index.ts"), `import type { CrewCoderExtAPI } from "@onpoint-dev-tools/crewcoder-agent";\n\nexport default function (crew: CrewCoderExtAPI) {\n  crew.handleEvent("context", async () => ({\n    context: "${titleFromId(id)} is installed. Add extension-specific guidance here."\n  }));\n\n  crew.defineTool({\n    name: "hello",\n    description: "Say hello from this extension.",\n    parameters: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },\n    async execute(_toolCallId, args) {\n      return { content: [{ type: "text", text: \`Hello, \${String(args.name ?? "CrewCoder")}!\` }] };\n    }\n  });\n\n  crew.defineCommand("hello", {\n    description: "Run a hello command from this extension.",\n    async handler(args, ctx) {\n      ctx.ui.notify(\`Hello \${args || "CrewCoder"}\`);\n    }\n  });\n}\n`);
  await fs.writeFile(path.join(dir, "README.md"), `# ${titleFromId(id)}\n\nCrewCoder extension package. Extensions are capability-based: add any combination of a CrewCoderExtAPI module, providers, tools, skills, prompt packs, commands, workflows, context providers, validators, approval policies, hooks, or future contribution points to \`crewcoder.extension.json\`.\n\nThis extends CrewCoder itself and is separate from CrewCode app plugins.\n\nInstall path:\n\n\`\`\`txt\n${dir}\n\`\`\`\n\nEnable trusted module execution and tool exposure when you trust this extension:\n\n\`\`\`bash\ncrewcoder config set allowExtensionModules true\ncrewcoder config set allowExtensionTools true\ncrewcoder extension trust ${id}\n\`\`\`\n`);
  return ["crewcoder.extension.json", "index.ts", "README.md"];
}

function buildManifest(id: string): CrewCoderExtensionManifest {
  return {
    id,
    name: titleFromId(id),
    version: "0.1.0",
    description: "Describe what this CrewCoder extension adds.",
    crewcoder: { apiVersion: "0.1" },
    main: "index.ts",
    activation: {
      events: [],
      keywords: [],
      modes: [],
      commands: [],
      filePatterns: []
    },
    contributes: {
      providers: [],
      tools: [],
      skills: [],
      promptPacks: [],
      commands: [],
      workflows: [],
      contextProviders: [],
      validators: [],
      approvalPolicies: [],
      hooks: [],
      ui: []
    }
  };
}
