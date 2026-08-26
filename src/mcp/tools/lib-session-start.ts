/**
 * lib_session_start — open a new session for a project.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibSessionStartArgs {
  project: string;
}

export const libSessionStartTool: ToolDefinition<LibSessionStartArgs> = {
  name: "lib_session_start",
  description: "Open a new session for a project. Returns the new session.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project name" },
    },
    required: ["project"],
  },
  handler: async (args, db) => {
    const session = db.startSession(args.project);
    return text({ session });
  },
};