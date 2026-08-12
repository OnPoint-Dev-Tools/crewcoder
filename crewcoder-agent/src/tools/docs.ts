import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import type { ResolvedAgentMode } from "../core/types.js";
import { embeddedCrewCodeDocs, queryCrewCodeDocs, findCrewCodeDoc, type EmbeddedDoc } from "../knowledge/crewcode-docs.js";
import {
  embeddedCrewCoderExtensionDocs,
  queryCrewCoderExtensionDocs,
  findCrewCoderExtensionDoc
} from "../knowledge/crewcoder-extension-docs.js";

type Args = { id?: string; query?: string };

type DocSet = {
  /** Label printed above results so plugin and extension docs never read as one set. */
  label: string;
  docs: EmbeddedDoc[];
  find(id: string): EmbeddedDoc | undefined;
  search(query: string): EmbeddedDoc[];
};

const pluginDocs: DocSet = {
  label: "CrewCode app plugins",
  docs: embeddedCrewCodeDocs,
  find: findCrewCodeDoc,
  search: queryCrewCodeDocs
};

const extensionDocs: DocSet = {
  label: "CrewCoder extensions",
  docs: embeddedCrewCoderExtensionDocs,
  find: findCrewCoderExtensionDoc,
  search: queryCrewCoderExtensionDocs
};

/**
 * Which doc sets a mode may read.
 *
 * Plugin and extension mode are scoped to their own set so the model cannot pull a
 * `crewcode.plugin.json` reference into an extension task. General mode gets both,
 * because a general-mode question about either system is legitimate.
 */
function docSetsForMode(mode: ResolvedAgentMode, profile: "standalone" | "crewcode"): DocSet[] {
  if (profile === "standalone") return [extensionDocs];
  if (mode === "plugin") return [pluginDocs];
  if (mode === "extension") return [extensionDocs];
  return [pluginDocs, extensionDocs];
}

function renderDoc(doc: EmbeddedDoc, label: string): string {
  // `content` supplies its own top-level heading, so only a provenance line is added.
  // Prepending the title too printed the heading twice.
  const provenance = `${label} · doc id: ${doc.id}`;
  const body = doc.content?.trim();
  if (!body) return `# ${doc.title}\n${provenance}\n\n${doc.summary}\n\n(No extended reference is embedded for this doc.)`;
  return `${provenance}\n\n${body}`;
}

function renderIndex(sets: DocSet[]): string {
  const lines: string[] = [];
  for (const set of sets) {
    lines.push(`## ${set.label}`);
    for (const doc of set.docs) lines.push(`- ${doc.id}: ${doc.title} — ${doc.summary}`);
    lines.push("");
  }
  lines.push('Call docs again with { "id": "<id>" } to read the full reference.');
  return lines.join("\n");
}

export function createDocsTool(profile: "standalone" | "crewcode" = "standalone", mode?: ResolvedAgentMode): ToolDefinition<Args> {
  const subject = mode === "plugin"
    ? "CrewCode app plugin"
    : mode === "extension"
      ? "CrewCoder extension"
      : profile === "crewcode"
        ? "CrewCode app plugin and CrewCoder extension"
        : "CrewCoder extension";
  return {
  name: "docs",
  description: `Read embedded ${subject} references. Call with an id to get the full buildable doc, with a query to search, or with no arguments to list every available doc id.`,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Exact doc id to read in full, e.g. extension-hooks or plugin-permissions." },
      query: { type: "string", description: "Search text matched against doc titles, summaries, and tags." }
    },
    additionalProperties: false
  },
  executionMode: "parallel",
  parse(args) {
    return {
      id: typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined,
      query: typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined
    };
  },
  async execute(args, context) {
    const sets = docSetsForMode(context.mode, context.integrationProfile ?? profile);

    if (args.id) {
      for (const set of sets) {
        const doc = set.find(args.id);
        if (doc) return textResult(renderDoc(doc, set.label), { docId: doc.id, set: set.label, hasContent: Boolean(doc.content) });
      }
      const known = sets.flatMap((set) => set.docs.map((doc) => doc.id));
      return textResult(
        `No embedded doc has id "${args.id}".\n\nAvailable ids:\n${known.map((id) => `- ${id}`).join("\n")}`,
        { docId: args.id, found: false, availableIds: known }
      );
    }

    if (args.query) {
      const matched = sets.flatMap((set) => set.search(args.query!).map((doc) => ({ set, doc })));
      if (!matched.length) {
        return textResult(`No embedded doc matched "${args.query}".\n\n${renderIndex(sets)}`, { query: args.query, matches: 0 });
      }
      // One match is unambiguous, so return the full body instead of making the model
      // spend another turn asking for it by id.
      if (matched.length === 1) {
        const only = matched[0]!;
        return textResult(renderDoc(only.doc, only.set.label), { docId: only.doc.id, set: only.set.label, matches: 1 });
      }
      const lines = matched.map(({ set, doc }) => `- ${doc.id} (${set.label}): ${doc.title} — ${doc.summary}`);
      return textResult(
        `${matched.length} docs matched "${args.query}":\n${lines.join("\n")}\n\nCall docs again with { "id": "<id>" } to read one in full.`,
        { query: args.query, matches: matched.length, docIds: matched.map(({ doc }) => doc.id) }
      );
    }

    return textResult(renderIndex(sets), { docIds: sets.flatMap((set) => set.docs.map((doc) => doc.id)) });
  }
};
}

/** Standalone-safe default for direct imports and generic hosts. */
export const docsTool = createDocsTool("standalone");
