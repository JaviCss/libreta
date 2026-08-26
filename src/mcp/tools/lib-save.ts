/**
 * lib_save — save a new observation to libreta memory.
 */

import type { ObservationType } from "../../types/memory.js";
import { OBSERVATION_TYPES } from "../../types/memory.js";
import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibSaveArgs {
  project: string;
  session_id?: string;
  topic_key?: string;
  title: string;
  type: string;
  what: string;
  why: string;
  where: string;
  learned: string;
}

export const libSaveTool: ToolDefinition<LibSaveArgs> = {
  name: "lib_save",
  description:
    "Save an observation to libreta memory. Use after completing significant work (a fix, a decision, a learning).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: 'Project name (e.g. "libreta")' },
      session_id: { type: "string", description: "Optional session ID" },
      topic_key: { type: "string", description: "Optional topic key for grouping" },
      title: { type: "string", description: "Short title (one line)" },
      type: {
        type: "string",
        enum: [...OBSERVATION_TYPES],
        description: "Observation category",
      },
      what: { type: "string", description: "What happened / was done" },
      why: { type: "string", description: "Why this approach" },
      where: { type: "string", description: "File/function/commit reference" },
      learned: { type: "string", description: "Takeaway for the future" },
    },
    required: ["project", "title", "type", "what", "why", "where", "learned"],
  },
  handler: async (args, db) => {
    if (!OBSERVATION_TYPES.includes(args.type as ObservationType)) {
      throw new Error(
        `Invalid type "${args.type}". Must be one of: ${OBSERVATION_TYPES.join(", ")}.`,
      );
    }
    const obs = db.save({
      project: args.project,
      session_id: args.session_id,
      topic_key: args.topic_key,
      title: args.title,
      type: args.type as ObservationType,
      what: args.what,
      why: args.why,
      where: args.where,
      learned: args.learned,
    });
    return text({ id: obs.id, created_at: obs.created_at });
  },
};