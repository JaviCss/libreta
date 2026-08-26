/**
 * Validation for libreta import payloads (see lib_export / lib_import).
 *
 * An import file is external input: it may come from another machine,
 * another version, or a hostile source. Every element is validated before
 * it reaches the DB so a malformed row can't bypass the type enum that
 * lib_save enforces, and a giant file can't OOM the process (callers check
 * MAX_IMPORT_BYTES against the file size BEFORE reading it).
 *
 * Fails fast with the index of the first invalid element — the import is
 * transactional (importAll), so all-or-nothing matches user expectations.
 */

import type { ExportPayload, Observation, ObservationType, Session } from "../types/memory.js";
import { OBSERVATION_TYPES } from "../types/memory.js";

/** Max import file size in bytes. 10 MB ≈ 20k observations — plenty for v0.1. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** Max length for any single string field in an imported row. */
const MAX_FIELD_LENGTH = 100_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Invalid import: ${where}: field "${key}" must be a non-empty string`);
  }
  if (v.length > MAX_FIELD_LENGTH) {
    throw new Error(
      `Invalid import: ${where}: field "${key}" exceeds ${MAX_FIELD_LENGTH} chars`,
    );
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new Error(`Invalid import: ${where}: field "${key}" must be a string when present`);
  }
  if (v.length > MAX_FIELD_LENGTH) {
    throw new Error(
      `Invalid import: ${where}: field "${key}" exceeds ${MAX_FIELD_LENGTH} chars`,
    );
  }
  return v;
}

function optionalRevisionCount(obj: Record<string, unknown>, where: string): number {
  const v = obj["revision_count"];
  if (v === undefined || v === null) return 1;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(
      `Invalid import: ${where}: field "revision_count" must be a positive integer when present`,
    );
  }
  return v;
}

function validateObservation(raw: unknown, index: number): Observation {
  const where = `observations[${index}]`;
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid import: ${where} must be an object`);
  }
  const type = requireString(raw, "type", where);
  if (!OBSERVATION_TYPES.includes(type as ObservationType)) {
    throw new Error(
      `Invalid import: ${where}: type "${type}" not one of: ${OBSERVATION_TYPES.join(", ")}`,
    );
  }
  const obs: Observation = {
    id: requireString(raw, "id", where),
    project: requireString(raw, "project", where),
    title: requireString(raw, "title", where),
    type: type as ObservationType,
    what: requireString(raw, "what", where),
    why: requireString(raw, "why", where),
    where: requireString(raw, "where", where),
    learned: requireString(raw, "learned", where),
    // Dedup lifecycle field (change libreta-dedup). Older export payloads
    // predate it, so it is optional on import and defaults to 1 ("seen once").
    revision_count: optionalRevisionCount(raw, where),
    created_at: requireString(raw, "created_at", where),
    updated_at: requireString(raw, "updated_at", where),
  };
  const sessionId = optionalString(raw, "session_id", where);
  if (sessionId !== undefined) obs.session_id = sessionId;
  const topicKey = optionalString(raw, "topic_key", where);
  if (topicKey !== undefined) obs.topic_key = topicKey;
  return obs;
}

function validateSession(raw: unknown, index: number): Session {
  const where = `sessions[${index}]`;
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid import: ${where} must be an object`);
  }
  const count = raw["observation_count"];
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
    throw new Error(`Invalid import: ${where}: observation_count must be a non-negative number`);
  }
  const s: Session = {
    id: requireString(raw, "id", where),
    project: requireString(raw, "project", where),
    started_at: requireString(raw, "started_at", where),
    observation_count: count,
  };
  const endedAt = optionalString(raw, "ended_at", where);
  if (endedAt !== undefined) s.ended_at = endedAt;
  const summary = optionalString(raw, "summary", where);
  if (summary !== undefined) s.summary = summary;
  return s;
}

/**
 * Validate a parsed JSON value as an export payload. Throws with a
 * specific message on the first problem; returns typed data on success.
 */
export function validateExportPayload(parsed: unknown): Pick<ExportPayload, "observations" | "sessions"> {
  if (!isPlainObject(parsed)) {
    throw new Error("Invalid export file: root must be a JSON object");
  }
  if (parsed["version"] !== 1) {
    throw new Error(
      `Invalid export file: unsupported version ${JSON.stringify(parsed["version"])} (expected 1)`,
    );
  }
  const observations = parsed["observations"];
  const sessions = parsed["sessions"];
  if (!Array.isArray(observations) || !Array.isArray(sessions)) {
    throw new Error("Invalid export file: missing observations[] or sessions[]");
  }
  return {
    observations: observations.map(validateObservation),
    sessions: sessions.map(validateSession),
  };
}
