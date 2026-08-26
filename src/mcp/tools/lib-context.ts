/**
 * lib_context — return recent observations + current session for a project.
 * Used by agents at the start of a task to get up-to-speed.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibContextArgs {
  project: string;
  limit?: number;
}

export const libContextTool: ToolDefinition<LibContextArgs> = {
  name: "lib_context",
  description:
    "Get recent observations for a project (and the most recent open session, if any). Use this at the start of a task to get context.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project name" },
      limit: { type: "number", description: "Max recent observations (default 20)" },
    },
    required: ["project"],
  },
  handler: async (args, db) => {
    const recent = db.list({ project: args.project, limit: args.limit ?? 20 });
    const sessions = db.listSessions(args.project);
    const currentSession = sessions.find((s) => !s.ended_at);
    return text({ recent, current_session: currentSession });
  },
};