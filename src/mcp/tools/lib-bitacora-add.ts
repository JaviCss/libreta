/**
 * lib_bitacora_add — record a day-level bitácora entry.
 *
 * The bitácora is a "supercalendario": one executive index entry per day
 * (headline + summary), DISTINCT from observations — it carries no
 * why/where/learned. It MAY link to the observation ids of that day.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";
import { isBitacoraEnabled } from "../../components/bitacora-config.js";

interface LibBitacoraAddArgs {
  project: string;
  date: string;
  headline: string;
  summary: string;
  linked_ids?: string[];
}

export const libBitacoraAddTool: ToolDefinition<LibBitacoraAddArgs> = {
  name: "lib_bitacora_add",
  description:
    "Record a bitácora day entry: a day-level executive index (headline + summary) of what was done, " +
    "distinct from observations (no why/where/learned). May link the observation ids of that day.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: 'Project name (e.g. "libreta")' },
      date: { type: "string", description: "The day this entry summarizes (ISO date, e.g. 2026-07-21)" },
      headline: { type: "string", description: "One-line executive headline for the day" },
      summary: { type: "string", description: "The day's executive summary" },
      linked_ids: {
        type: "array",
        items: { type: "string" },
        description: "Optional observation ids of that day this entry indexes",
      },
    },
    required: ["project", "date", "headline", "summary"],
  },
  handler: async (args, db) => {
    // Gate ONLY the write path on the toggle. When OFF we refuse to persist and
    // say so plainly; reads (lib_bitacora_day / lib_bitacora_range) stay open so
    // existing entries remain visible. Default is ON (flag file absent).
    if (!isBitacoraEnabled()) {
      return text({
        skipped: true,
        enabled: false,
        message:
          "La bitácora está apagada; no se guardó la entrada. Reactivá con `libreta bitacora enable`.",
      });
    }
    const entry = db.addBitacora({
      project: args.project,
      date: args.date,
      headline: args.headline,
      summary: args.summary,
      linked_ids: args.linked_ids ?? [],
    });
    return text({ id: entry.id, created_at: entry.created_at });
  },
};
