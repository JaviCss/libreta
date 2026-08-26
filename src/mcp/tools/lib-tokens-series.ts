/**
 * lib_tokens_series — read the stored per-agent token rows. Read-only: an
 * agent may consult the series but has no tool that writes into it.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";
import { ATTRIBUTION_NOTE } from "../../telemetry/report.js";

interface LibTokensSeriesArgs {
  session_id?: string;
  agent?: string;
  model?: string;
  task_type?: string;
  from?: string;
  to?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 200;

export const libTokensSeriesTool: ToolDefinition<LibTokensSeriesArgs> = {
  name: "lib_tokens_series",
  description:
    "Read the per-agent token telemetry rows (read-only). Filter by session, agent, model, task type " +
    "or ingest date range. Cache reads are kept apart from work, and the prose/tool_call/code/test/doc " +
    "split is attributed, not measured.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Only this session id" },
      agent: { type: "string", description: 'Only this agent (e.g. "coder", "revisor", "main")' },
      model: { type: "string", description: "Only this model" },
      task_type: { type: "string", description: 'Only this task type (e.g. "apply", "verify", "other")' },
      from: { type: "string", description: "Ingested on or after this ISO date" },
      to: { type: "string", description: "Ingested on or before this ISO date" },
      limit: { type: "number", description: `Max rows to return (default ${DEFAULT_LIMIT})` },
    },
  },
  handler: async (args, db) => {
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;
    const all = db.telemetryQuery({
      ...(args.session_id ? { session_id: args.session_id } : {}),
      ...(args.agent ? { agent: args.agent } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.task_type ? { task_type: args.task_type } : {}),
      ...(args.from ? { from: args.from } : {}),
      ...(args.to ? { to: args.to } : {}),
    });
    return text({
      rows: all.slice(0, limit),
      total: all.length,
      truncated: all.length > limit,
      attribution_note: ATTRIBUTION_NOTE,
    });
  },
};
