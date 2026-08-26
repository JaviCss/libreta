/**
 * lib_delete — delete an observation by id.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibDeleteArgs {
  id: string;
}

export const libDeleteTool: ToolDefinition<LibDeleteArgs> = {
  name: "lib_delete",
  description: "Delete an observation by id. Returns whether the row was removed.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Observation ULID" },
    },
    required: ["id"],
  },
  handler: async (args, db) => {
    const deleted = db.delete(args.id);
    return text({ deleted });
  },
};