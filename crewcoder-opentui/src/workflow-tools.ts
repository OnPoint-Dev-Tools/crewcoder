import { normalize, type ToolBlock } from "./transcript.js";

/**
 * CrewCoder-mode workflow tools (`docs/TRANSCRIPT.md#plans-and-questions`), drawn from
 * their arguments rather than as tool output, as in legacy `MainViewport`: the
 * clarify step lists its questions, and a proposed plan reads as sections with the
 * approval hint. Never collapsed: the user approves what they can read. Pure.
 */

export const CLARIFY_TOOL = "crewcoder_clarify";
export const PROPOSE_PLAN_TOOL = "crewcoder_propose_plan";

export const PLAN_APPROVAL_HINT = "Approve with /approve-plan, or reply approve. Describe revisions instead if this plan is wrong.";

/** One planned file change: `modify src/a.ts`, why, and a representative snippet. */
export type WorkflowFile = { action: string; path: string; description: string; snippet?: string };

export type WorkflowSection =
  | { kind: "text"; heading?: string; text: string }
  | { kind: "list"; heading?: string; items: string[] }
  | { kind: "files"; heading: string; files: WorkflowFile[] };

export type WorkflowView = { title: string; sections: WorkflowSection[]; hint?: string };

/** The view of a clarify or plan tool, or undefined for other tools and failed calls (those show their error). */
export function workflowView(block: ToolBlock): WorkflowView | undefined {
  if (block.status === "error") return undefined;
  if (block.name === CLARIFY_TOOL) return clarifyView(block);
  if (block.name === PROPOSE_PLAN_TOOL) return planView(block);
  return undefined;
}

function clarifyView(block: ToolBlock): WorkflowView {
  const questions = stringList(block.args?.questions);
  if (questions.length > 0) return { title: "Clarifying questions", sections: [{ kind: "list", items: questions }] };
  return { title: "Clarifying questions", sections: fallback(block) };
}

function planView(block: ToolBlock): WorkflowView {
  const args = block.args ?? {};
  const sections: WorkflowSection[] = [];
  const text = (heading: string, value: unknown): void => {
    const body = stringValue(value);
    if (body) sections.push({ kind: "text", heading, text: body });
  };
  text("Requirements", args.requirements);
  text("Investigation", args.investigation);
  const files = fileChanges(args.fileChanges);
  if (files.length > 0) sections.push({ kind: "files", heading: "File changes", files });
  text("Plan", args.plan);
  text("Acceptance criteria", args.acceptanceCriteria);
  if (sections.length === 0) return { title: "Proposed plan", sections: fallback(block) };
  return { title: "Proposed plan", sections, hint: PLAN_APPROVAL_HINT };
}

/** No usable arguments: the tool's own text, so nothing is lost. */
function fallback(block: ToolBlock): WorkflowSection[] {
  const text = normalize(block.text ?? "").trim();
  return text ? [{ kind: "text", text }] : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? normalize(value).trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? normalize(item).trim() : "")).filter(Boolean) : [];
}

function fileChanges(value: unknown): WorkflowFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): WorkflowFile[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const path = stringValue(record.path);
    if (!path) return [];
    const snippet = stringValue(record.snippet);
    return [{ action: stringValue(record.action) || "change", path, description: stringValue(record.description), ...(snippet ? { snippet } : {}) }];
  });
}

/** The text a view draws, in order, for transcript search (headings and the hint are labels, not content). */
export function workflowTexts(view: WorkflowView): string[] {
  return view.sections.flatMap((section) => {
    if (section.kind === "text") return [section.text];
    if (section.kind === "list") return section.items.map((item, index) => `${index + 1}. ${item}`);
    return section.files.flatMap((file) => [
      fileLine(file),
      ...(file.description ? [file.description] : []),
      ...(file.snippet ? [file.snippet] : [])
    ]);
  });
}

/** `modify src/a.ts` */
export function fileLine(file: Pick<WorkflowFile, "action" | "path">): string {
  return `${file.action} ${file.path}`;
}
