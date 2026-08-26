/**
 * lib_session_end — close a session, with optional summary.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibSessionEndArgs {
  id: string;
  summary?: string;
}

export const libSessionEndTool: ToolDefinition<LibSessionEndArgs> = {
  name: "lib_session_end",
  description: "Close a session. Optional human-readable summary.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Session ULID" },
      summary: { type: "string", description: "Optional summary of what was done in this session" },
    },
    required: ["id"],
  },
  handler: async (args, db) => {
    const session = db.endSession(args.id, args.summary);
    return text({ session });
  },
};