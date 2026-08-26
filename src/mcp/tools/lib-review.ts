/**
 * lib_review — list the most recent observations for a project.
 * Used by agents to do periodic "what did we learn this week?" reviews.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibReviewArgs {
  project: string;
  since?: string; // ISO 8601 timestamp — only return observations newer than this
  limit?: number;
}

export const libReviewTool: ToolDefinition<LibReviewArgs> = {
  name: "lib_review",
  description: "List the most recent observations for a project, optionally filtered by `since`.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project name" },
      since: { type: "string", description: "ISO 8601 timestamp — only newer than this" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    required: ["project"],
  },
  handler: async (args, db) => {
    let observations = db.list({ project: args.project, limit: args.limit ?? 20 });
    if (args.since) {
      observations = observations.filter((o) => o.created_at > args.since!);
    }
    return text({ observations });
  },
};