/**
 * lib_tokens_report — grouped totals over the telemetry series. Read-only, and
 * it never states a cost: prices are an input to `libreta tokens report`,
 * not stored state.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";
import { buildReport } from "../../telemetry/report.js";
import { TELEMETRY_AXES, type TelemetryAxis } from "../../telemetry/types.js";

interface LibTokensReportArgs {
  axis?: string;
  session_id?: string;
  agent?: string;
  task_type?: string;
  from?: string;
  to?: string;
}

export const libTokensReportTool: ToolDefinition<LibTokensReportArgs> = {
  name: "lib_tokens_report",
  description:
    "Group the per-agent token telemetry by agent, model, task type or session (read-only). The " +
    "main thread's spend is published as an explicit unattributed remainder, never spread across " +
    "the groups. States no cost: pricing lives in `libreta tokens report --prices`.",
  inputSchema: {
    type: "object",
    properties: {
      axis: { type: "string", description: `Group by one of: ${TELEMETRY_AXES.join(", ")}`, enum: [...TELEMETRY_AXES] },
      session_id: { type: "string", description: "Only this session id" },
      agent: { type: "string", description: "Only this agent" },
      task_type: { type: "string", description: "Only this task type" },
      from: { type: "string", description: "Ingested on or after this ISO date" },
      to: { type: "string", description: "Ingested on or before this ISO date" },
    },
  },
  handler: async (args, db) => {
    const axis = (args.axis ?? "agent") as TelemetryAxis;
    if (!TELEMETRY_AXES.includes(axis)) {
      throw new Error(`unsupported telemetry axis: ${String(args.axis)} (allowed: ${TELEMETRY_AXES.join(", ")})`);
    }
    const report = buildReport(db, {
      axis,
      filter: {
        ...(args.session_id ? { session_id: args.session_id } : {}),
        ...(args.agent ? { agent: args.agent } : {}),
        ...(args.task_type ? { task_type: args.task_type } : {}),
        ...(args.from ? { from: args.from } : {}),
        ...(args.to ? { to: args.to } : {}),
      },
    });
    return text({
      axis: report.axis,
      groups: report.groups,
      unattributed_main: report.unattributedMain,
      price_source: report.priceSource,
      attribution_note: report.attributionNote,
      partial_rows: report.partialRows,
    });
  },
};
