/**
 * MCP tool barrel — registers all lib_* tools for the server.
 */

export type { ToolDefinition } from "./_types.js";
export { text } from "./_types.js";
import type { ToolDefinition } from "./_types.js";

import { libSaveTool } from "./lib-save.js";
import { libSearchTool } from "./lib-search.js";
import { libUpdateTool } from "./lib-update.js";
import { libDeleteTool } from "./lib-delete.js";
import { libGetTool } from "./lib-get.js";
import { libContextTool } from "./lib-context.js";
import { libTimelineTool } from "./lib-timeline.js";
import { libSessionStartTool } from "./lib-session-start.js";
import { libSessionEndTool } from "./lib-session-end.js";
import { libSessionSummaryTool } from "./lib-session-summary.js";
import { libReviewTool } from "./lib-review.js";
import { libStatsTool } from "./lib-stats.js";
import { libExportTool } from "./lib-export.js";
import { libImportTool } from "./lib-import.js";
import { libDoctorTool } from "./lib-doctor.js";
import { libBitacoraAddTool } from "./lib-bitacora-add.js";
import { libBitacoraDayTool } from "./lib-bitacora-day.js";
import { libBitacoraRangeTool } from "./lib-bitacora-range.js";
import { libCriteriaTool } from "./lib-criteria.js";
import { libTokensSeriesTool } from "./lib-tokens-series.js";
import { libTokensReportTool } from "./lib-tokens-report.js";

// Wide-typed wrapper for the registry: each tool has its own arg shape,
// but the array only needs to know name/description/schema/handler signature.
interface ToolRegistryEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolDefinition<never>["inputSchema"];
  readonly handler: (args: unknown, db: import("../../storage/libreta-db.js").LibretaDB) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

export const ALL_TOOLS: ReadonlyArray<ToolRegistryEntry> = [
  libSaveTool as unknown as ToolRegistryEntry,
  libSearchTool as unknown as ToolRegistryEntry,
  libUpdateTool as unknown as ToolRegistryEntry,
  libDeleteTool as unknown as ToolRegistryEntry,
  libGetTool as unknown as ToolRegistryEntry,
  libContextTool as unknown as ToolRegistryEntry,
  libTimelineTool as unknown as ToolRegistryEntry,
  libSessionStartTool as unknown as ToolRegistryEntry,
  libSessionEndTool as unknown as ToolRegistryEntry,
  libSessionSummaryTool as unknown as ToolRegistryEntry,
  libReviewTool as unknown as ToolRegistryEntry,
  libStatsTool as unknown as ToolRegistryEntry,
  libExportTool as unknown as ToolRegistryEntry,
  libImportTool as unknown as ToolRegistryEntry,
  libDoctorTool as unknown as ToolRegistryEntry,
  libBitacoraAddTool as unknown as ToolRegistryEntry,
  libBitacoraDayTool as unknown as ToolRegistryEntry,
  libBitacoraRangeTool as unknown as ToolRegistryEntry,
  libCriteriaTool as unknown as ToolRegistryEntry,
  libTokensSeriesTool as unknown as ToolRegistryEntry,
  libTokensReportTool as unknown as ToolRegistryEntry,
];