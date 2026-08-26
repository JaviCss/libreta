/**
 * lib_update — patch an existing observation by id.
 */

import type { Observation, ObservationType } from "../../types/memory.js";
import { OBSERVATION_TYPES } from "../../types/memory.js";
import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibUpdateArgs {
  id: string;
  patch: Record<string, unknown>;
}

/** Fields a patch may touch — everything except id/created_at/updated_at. */
const PATCHABLE_FIELDS = [
  "project",
  "session_id",
  "topic_key",
  "title",
  "type",
  "what",
  "why",
  "where",
  "learned",
] as const;

/**
 * Validate a raw patch object: only patchable string fields, and `type`
 * must stay inside the same enum that lib_save enforces. Without this, a
 * patch was a backdoor around every invariant of the save path.
 */
function validatePatch(
  raw: Record<string, unknown>,
): Partial<Omit<Observation, "id" | "created_at" | "updated_at">> {
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    throw new Error("patch must contain at least one field");
  }
  for (const key of keys) {
    if (!(PATCHABLE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `patch field "${key}" is not allowed. Patchable fields: ${PATCHABLE_FIELDS.join(", ")}`,
      );
    }
    if (typeof raw[key] !== "string") {
      throw new Error(`patch field "${key}" must be a string`);
    }
  }
  if (raw.type !== undefined && !OBSERVATION_TYPES.includes(raw.type as ObservationType)) {
    throw new Error(
      `Invalid type "${raw.type}". Must be one of: ${OBSERVATION_TYPES.join(", ")}.`,
    );
  }
  return raw as Partial<Omit<Observation, "id" | "created_at" | "updated_at">>;
}

export const libUpdateTool: ToolDefinition<LibUpdateArgs> = {
  name: "lib_update",
  description:
    "Patch fields on an existing observation. Bumps updated_at. " +
    `Patchable fields: ${PATCHABLE_FIELDS.join(", ")}.`,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Observation ULID" },
      patch: { type: "object", description: "Partial fields to update (string values only)" },
    },
    required: ["id", "patch"],
  },
  handler: async (args, db) => {
    const patch = validatePatch(args.patch ?? {});
    const updated = db.update(args.id, patch);
    return text({ updated: updated !== null, observation: updated });
  },
};
