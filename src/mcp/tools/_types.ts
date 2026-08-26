/**
 * Shared types for MCP tool implementations.
 *
 * Each lib_* tool exports a `name`, `description`, `inputSchema` (Zod-less
 * JSON Schema object), and an async `handler(args, db)` that returns the
 * MCP content array.
 */

import type { LibretaDB } from "../../storage/libreta-db.js";

/** JSON Schema object describing the tool's input parameters. */
export type ToolSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: readonly string[];
};

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolSchema;
  readonly handler: (args: TArgs, db: LibretaDB) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

/** Helper: wrap a JSON-serializable value as MCP text content. */
export function text(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}