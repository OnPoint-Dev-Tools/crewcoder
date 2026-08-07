import { assertSessionId } from "./session-admin.js";
import {
  listSessionCheckpoints,
  previewSessionCheckpointRestore,
  restoreSessionCheckpoint,
  type SessionCheckpoint,
  type SessionCheckpointPreview,
  type SessionCheckpointRestore
} from "./session-checkpoints.js";
import { loadSessionRecord, saveSession } from "./session-store.js";

export type SessionRewindResult = {
  checkpoint: SessionCheckpoint;
  audit: SessionCheckpointRestore;
};

export async function listSessionCheckpointRecords(sessionId: string): Promise<SessionCheckpoint[]> {
  return listSessionCheckpoints(assertSessionId(sessionId));
}

export async function previewSessionRewind(sessionId: string, checkpointId: string, cwd: string): Promise<SessionCheckpointPreview> {
  return previewSessionCheckpointRestore(assertSessionId(sessionId), assertCheckpointId(checkpointId), { cwd });
}

export async function rewindSessionToCheckpoint(sessionId: string, checkpointId: string, cwd: string): Promise<SessionRewindResult> {
  const id = assertSessionId(sessionId);
  const checkpoint = assertCheckpointId(checkpointId);
  const result = await restoreSessionCheckpoint(id, checkpoint, { cwd });
  const audit: SessionCheckpointRestore = {
    checkpointId: checkpoint,
    sessionId: id,
    restoredAt: new Date().toISOString(),
    restoredFiles: result.restoredFiles,
    deletedFiles: result.deletedFiles
  };
  const record = await loadSessionRecord(id);
  await saveSession({
    ...record,
    events: [...record.events, { type: "checkpoint_restored", ...audit }],
    checkpointRestores: [...(record.checkpointRestores ?? []), audit]
  });
  return { checkpoint: result.checkpoint, audit };
}

function assertCheckpointId(checkpointId: string): string {
  const value = checkpointId.trim();
  if (!/^checkpoint_[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Checkpoint id must start with checkpoint_ and contain only letters, numbers, underscores, and hyphens.");
  }
  return value;
}
