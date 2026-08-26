/**
 * lib_stats — aggregate stats over the libreta.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibStatsArgs {}

export const libStatsTool: ToolDefinition<LibStatsArgs> = {
  name: "lib_stats",
  description: "Aggregate stats: observation count, session count, project count, DB size.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: async (_args, db) => {
    return text(db.stats());
  },
};