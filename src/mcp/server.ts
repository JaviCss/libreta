/**
 * MCP server bootstrap for the libreta memory component.
 *
 * Boots on stdio, exposes the 14 lib_* tools, talks to a SQLite DB at
 * ~/.libreta/libreta.db (overridable via LIBRETA_DB env var).
 *
 * Usage: `node dist/mcp/server.js` (called by agents automatically
 * once the memory component is installed).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { LibretaDB } from "../storage/libreta-db.js";
import { ALL_TOOLS } from "./tools/index.js";
import { validateToolArgs } from "./validate-args.js";

function resolveDbPath(): string {
  if (process.env.LIBRETA_DB) return process.env.LIBRETA_DB;
  const home =
    process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return join(home, ".libreta", "libreta.db");
}

function buildServer(dbPath: string): Server {
  const db = new LibretaDB(dbPath);
  db.init();
  const server = new Server(
    { name: "libreta", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = ALL_TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    // Enforce the inputSchema before the handler sees the args — the
    // schemas are a contract, not documentation.
    const args = validateToolArgs(tool.name, tool.inputSchema, request.params.arguments);
    // Cast: each tool knows its own arg shape via the typed ToolDefinition.
    return tool.handler(args as never, db);
  });

  // Expose the DB handle for tests / external introspectors via a side-channel.
  (server as unknown as { __db: LibretaDB }).__db = db;
  return server;
}

export { buildServer, resolveDbPath };

/** When invoked directly, run the server. */
async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const server = buildServer(dbPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio is the lifecycle — when stdin closes, the process exits naturally.
}

// Only run main when this file is the entry point (not when imported by tests).
const isEntry =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /server\.js$/.test(process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    console.error("[server] fatal:", err);
    process.exit(1);
  });
}