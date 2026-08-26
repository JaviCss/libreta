/**
 * lib_bitacora_range — read the bitácora entries for a project over a date range.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibBitacoraRangeArgs {
  project: string;
  from: string;
  to: string;
  limit?: number;
}

export const libBitacoraRangeTool: ToolDefinition<LibBitacoraRangeArgs> = {
  name: "lib_bitacora_range",
  description:
    "Read the bitácora entries for a project within a date range [from, to] inclusive (ISO dates), " +
    "ordered oldest day first.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: 'Project name (e.g. "libreta")' },
      from: { type: "string", description: "Start date, inclusive (ISO date, e.g. 2026-07-01)" },
      to: { type: "string", description: "End date, inclusive (ISO date, e.g. 2026-07-31)" },
      limit: { type: "number", description: "Max entries to return (default 500)" },
    },
    required: ["project", "from", "to"],
  },
  handler: async (args, db) => {
    const entries = db.bitacoraRange(
      args.project,
      args.from,
      args.to,
      args.limit !== undefined ? { limit: args.limit } : {},
    );
    return text({ entries });
  },
};
