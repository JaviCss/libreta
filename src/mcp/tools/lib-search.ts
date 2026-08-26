/**
 * lib_search — full-text search over observations.
 */

import type { ObservationType } from "../../types/memory.js";
import { OBSERVATION_TYPES } from "../../types/memory.js";
import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibSearchArgs {
  query: string;
  project?: string;
  type?: string;
  limit?: number;
}

export const libSearchTool: ToolDefinition<LibSearchArgs> = {
  name: "lib_search",
  description: "Full-text search over observations. Returns bm25-ranked results with snippets.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (FTS5 syntax: words, phrases with quotes)" },
      project: { type: "string", description: "Optional project filter" },
      type: {
        type: "string",
        enum: [...OBSERVATION_TYPES],
        description: "Optional type filter",
      },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    required: ["query"],
  },
  handler: async (args, db) => {
    if (!args.query || !args.query.trim()) {
      throw new Error("query must not be empty");
    }
    if (args.type && !OBSERVATION_TYPES.includes(args.type as ObservationType)) {
      throw new Error(
        `Invalid type "${args.type}". Must be one of: ${OBSERVATION_TYPES.join(", ")}.`,
      );
    }
    const results = db.search(args.query, {
      project: args.project,
      type: args.type as ObservationType | undefined,
      limit: args.limit,
    });
    return text({ results });
  },
};