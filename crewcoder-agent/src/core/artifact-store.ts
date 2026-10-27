import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getCrewCoderHome } from "./crewcoder-home.js";

export const ARTIFACT_FORMATS = ["html", "svg", "mermaid", "markdown"] as const;
export type ArtifactFormat = typeof ARTIFACT_FORMATS[number];
export const ARTIFACT_LIMITS = { maxContentBytes: 512 * 1024, maxArtifacts: 100, maxSessionBytes: 16 * 1024 * 1024 } as const;
const MIME_TYPES: Record<ArtifactFormat, string> = {
  html: "text/html", svg: "image/svg+xml", mermaid: "text/vnd.mermaid", markdown: "text/markdown"
};
export type ArtifactMetadata = {
  id: string; title: string; format: ArtifactFormat; mimeType: string;
  revision: number; byteSize: number; createdAt: string; updatedAt: string;
};
export type Artifact = ArtifactMetadata & { content: string };
export type ArtifactWrite = { id?: string; expectedRevision?: number; title: string; format: ArtifactFormat; content: string };

export class ArtifactError extends Error {
  readonly code: "invalid" | "not_found" | "conflict" | "limit" | "busy";
  constructor(code: ArtifactError["code"], message: string) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
  }
}

export function parseArtifactWrite(value: Record<string, unknown>): ArtifactWrite {
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 200 || /[\x00-\x1f\x7f]/.test(value.title)) {
    throw new ArtifactError("invalid", "title must be 1 to 200 characters without control characters");
  }
  if (!ARTIFACT_FORMATS.includes(value.format as ArtifactFormat)) throw new ArtifactError("invalid", "format must be html, svg, mermaid, or markdown");
  if (typeof value.content !== "string") throw new ArtifactError("invalid", "content must be a string");
  if (Buffer.byteLength(value.content, "utf8") > ARTIFACT_LIMITS.maxContentBytes) throw new ArtifactError("limit", "Artifact content exceeds 512 KiB");
  if (value.id !== undefined) {
    assertArtifactId(value.id);
    if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) throw new ArtifactError("invalid", "Updates require a positive integer expectedRevision");
  } else if (value.expectedRevision !== undefined) {
    throw new ArtifactError("invalid", "expectedRevision requires an artifact id");
  }
  return { title: value.title.trim(), format: value.format as ArtifactFormat, content: value.content, ...(value.id === undefined ? {} : { id: value.id as string, expectedRevision: value.expectedRevision as number }) };
}

export function assertArtifactId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^artifact_[a-f0-9-]{36}$/.test(id)) throw new ArtifactError("invalid", "Invalid artifact id");
}

export function artifactMetadata(artifact: Artifact): ArtifactMetadata {
  const { content: _content, ...metadata } = artifact;
  return metadata;
}

/** Source documents only: never evaluates content or accesses workspace/host file APIs. */
export class ArtifactStore {
  private readonly directory: string;

  constructor(sessionId: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) throw new ArtifactError("invalid", "Invalid session id");
    this.directory = path.join(getCrewCoderHome().root, "artifacts", sessionId);
  }

  private ensureDirectory(): void {
    const root = path.dirname(this.directory);
    // The configured home is trusted; each artifact-owned child must be a real directory.
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
    for (const directory of [root, this.directory]) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!fs.lstatSync(directory).isDirectory()) throw new ArtifactError("invalid", "Artifact storage cannot use symlink directories");
    }
  }

  public list(): ArtifactMetadata[] {
    this.ensureDirectory();
    const files: string[] = [];
    const directory = fs.opendirSync(this.directory);
    try {
      let count = 0;
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++count > ARTIFACT_LIMITS.maxArtifacts + 16) throw new ArtifactError("limit", "Artifact directory entry limit exceeded");
        if (entry.name.endsWith(".json")) files.push(entry.name);
      }
    } finally { directory.closeSync(); }
    if (files.length > ARTIFACT_LIMITS.maxArtifacts) throw new ArtifactError("limit", "Artifact count exceeds session limit");
    return files.map((name) => artifactMetadata(this.read(name.slice(0, -5)))).sort((a, b) => a.id.localeCompare(b.id));
  }

  public read(id: string): Artifact {
    assertArtifactId(id);
    this.ensureDirectory();
    let descriptor: number;
    try { descriptor = fs.openSync(path.join(this.directory, `${id}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArtifactError("not_found", "Artifact not found in this session");
      throw error;
    }
    try {
      const stat = fs.fstatSync(descriptor);
      // JSON escaping can expand each source byte sixfold.
      if (!stat.isFile() || stat.size > ARTIFACT_LIMITS.maxContentBytes * 6 + 4096) throw new ArtifactError("limit", "Invalid artifact record size");
      const raw: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ArtifactError("invalid", "Invalid artifact record");
      const record = raw as Record<string, unknown>;
      const parsed = parseArtifactWrite({ ...record, expectedRevision: record.revision });
      if (parsed.id !== id || record.mimeType !== MIME_TYPES[parsed.format] || record.byteSize !== Buffer.byteLength(parsed.content, "utf8") ||
          typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
          typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
        throw new ArtifactError("invalid", "Invalid artifact metadata");
      }
      return { id, title: parsed.title, format: parsed.format, mimeType: MIME_TYPES[parsed.format], content: parsed.content,
        revision: record.revision as number, byteSize: record.byteSize as number, createdAt: record.createdAt, updatedAt: record.updatedAt };
    } finally { fs.closeSync(descriptor); }
  }

  public write(value: ArtifactWrite, signal?: AbortSignal): Artifact {
    const input = parseArtifactWrite(value);
    signal?.throwIfAborted();
    this.ensureDirectory();
    const lock = path.join(this.directory, ".write-lock");
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ArtifactError("busy", "Artifact store is busy; retry. A stale .write-lock after a crash requires operator recovery.");
      throw error;
    }
    try {
      const previous = input.id ? this.read(input.id) : undefined;
      if (previous && previous.revision !== input.expectedRevision) throw new ArtifactError("conflict", `Artifact changed; read the latest revision (currently ${previous.revision}) before updating`);
      const existing = this.list();
      if (!previous && existing.length >= ARTIFACT_LIMITS.maxArtifacts) throw new ArtifactError("limit", "Session has reached 100 artifacts");
      const byteSize = Buffer.byteLength(input.content, "utf8");
      if (existing.reduce((sum, item) => sum + item.byteSize, 0) - (previous?.byteSize ?? 0) + byteSize > ARTIFACT_LIMITS.maxSessionBytes) throw new ArtifactError("limit", "Session artifact content exceeds 16 MiB");
      const now = new Date().toISOString();
      const artifact: Artifact = {
        id: previous?.id ?? `artifact_${randomUUID()}`, title: input.title, format: input.format, mimeType: MIME_TYPES[input.format],
        content: input.content, byteSize, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now
      };
      const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(artifact), { flag: "wx", mode: 0o600 });
        signal?.throwIfAborted();
        fs.renameSync(temporary, path.join(this.directory, `${artifact.id}.json`));
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return artifact;
    } finally { fs.rmdirSync(lock); }
  }
}
