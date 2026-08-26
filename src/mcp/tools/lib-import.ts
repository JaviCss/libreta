/**
 * lib_import — restore from a JSON file (see lib_export).
 */

import { readFileSync, statSync } from "node:fs";
import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";
import { assertSandboxedPath } from "../../utils/sandbox.js";
import { MAX_IMPORT_BYTES, validateExportPayload } from "../../storage/import-validation.js";

interface LibImportArgs {
  file: string;
}

export const libImportTool: ToolDefinition<LibImportArgs> = {
  name: "lib_import",
  description:
    "Import observations + sessions from a JSON file (idempotent — skips existing ids). " +
    "The source must live under ~/.libreta or the current project directory.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "Source file path (must be under ~/.libreta or the project dir)",
      },
    },
    required: ["file"],
  },
  handler: async (args, db) => {
    const file = assertSandboxedPath(args.file);
    const size = statSync(file).size;
    if (size > MAX_IMPORT_BYTES) {
      throw new Error(
        `Import file too large: ${size} bytes (max ${MAX_IMPORT_BYTES}). Split the export.`,
      );
    }
    const payload = validateExportPayload(JSON.parse(readFileSync(file, "utf8")));
    const counts = db.importAll(payload);
    return text({ imported: counts });
  },
};