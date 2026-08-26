/**
 * lib_bitacora_day — read the bitácora entries for a project on a given day.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

interface LibBitacoraDayArgs {
  project: string;
  date: string;
}

export const libBitacoraDayTool: ToolDefinition<LibBitacoraDayArgs> = {
  name: "lib_bitacora_day",
  description:
    "Read the bitácora day entries for a project on a given day (ISO date), newest-recorded first.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: 'Project name (e.g. "libreta")' },
      date: { type: "string", description: "The day to read (ISO date, e.g. 2026-07-21)" },
    },
    required: ["project", "date"],
  },
  handler: async (args, db) => {
    const entries = db.bitacoraDay(args.project, args.date);
    return text({ entries });
  },
};
