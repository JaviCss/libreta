/**
 * lib_get — fetch an observation by id.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibGetArgs {
  id: string;
}

export const libGetTool: ToolDefinition<LibGetArgs> = {
  name: "lib_get",
  description: "Fetch a single observation by id.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Observation ULID" },
    },
    required: ["id"],
  },
  handler: async (args, db) => {
    const observation = db.getById(args.id);
    return text({ observation });
  },
};