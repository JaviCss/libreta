/**
 * lib_session_summary — full summary of a session: its meta + all observations.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibSessionSummaryArgs {
  id: string;
}

export const libSessionSummaryTool: ToolDefinition<LibSessionSummaryArgs> = {
  name: "lib_session_summary",
  description: "Get a session's metadata plus all observations that belong to it.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Session ULID" },
    },
    required: ["id"],
  },
  handler: async (args, db) => {
    const session = db.getSession(args.id);
    if (!session) return text({ error: "session not found" });
    const observations = db.list({ session_id: args.id, limit: 1_000_000 });
    return text({ session, observations });
  },
};