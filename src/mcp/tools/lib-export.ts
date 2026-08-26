/**
 * lib_export — dump everything (or a project) to a JSON file.
 */

import { writeFileSync } from "node:fs";
import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";
import { assertSandboxedPath } from "../../utils/sandbox.js";

interface LibExportArgs {
  project?: string;
  file: string;
}

export const libExportTool: ToolDefinition<LibExportArgs> = {
  name: "lib_export",
  description:
    "Export all observations + sessions to a JSON file. Returns the path and the count. " +
    "The destination must live under ~/.libreta or the current project directory.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Optional project filter (default: all)" },
      file: {
        type: "string",
        description: "Destination file path (must be under ~/.libreta or the project dir)",
      },
    },
    required: ["file"],
  },
  handler: async (args, db) => {
    const file = assertSandboxedPath(args.file);
    const payload = db.exportAll(args.project);
    writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return text({ path: file, count: payload.observations.length });
  },
};