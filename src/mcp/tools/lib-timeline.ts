/**
 * lib_timeline — return the observations immediately before and after a
 * given observation (by created_at), within `depth` rows.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibTimelineArgs {
  id: string;
  depth?: number;
}

export const libTimelineTool: ToolDefinition<LibTimelineArgs> = {
  name: "lib_timeline",
  description:
    "Get observations immediately before and after a given id (within `depth` rows each side). Useful for 'what happened around this fix?'",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Center observation ULID" },
      depth: { type: "number", description: "How many neighbors each side (default 5)" },
    },
    required: ["id"],
  },
  handler: async (args, db) => {
    const target = db.getById(args.id);
    if (!target) return text({ error: "observation not found" });
    const depth = args.depth ?? 5;
    // Fetch the recent list of the same project and find the target's position.
    const project = target.project;
    const all = db.list({ project, limit: 1_000_000 });
    const idx = all.findIndex((o) => o.id === args.id);
    if (idx < 0) return text({ before: [], after: [] });
    const before = all.slice(Math.max(0, idx - depth), idx);
    const after = all.slice(idx + 1, idx + 1 + depth);
    return text({ before, after });
  },
};