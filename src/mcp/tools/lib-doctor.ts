/**
 * lib_doctor — health check on the libreta DB.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibDoctorArgs {}

export const libDoctorTool: ToolDefinition<LibDoctorArgs> = {
  name: "lib_doctor",
  description: "Run a health check on the libreta DB. Returns ok + list of issues.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: async (_args, db) => {
    return text(db.doctor());
  },
};