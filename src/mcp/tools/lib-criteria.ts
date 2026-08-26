/**
 * lib_criteria — return a persona's personal validation criteria.
 *
 * Criteria are ordinary `preference` observations stored under
 * `topic_key = "criteria:<persona>"` (change persona-criteria). This tool is
 * the runtime read: given a persona (and optional project), it returns those
 * observations ranked by how often they have been confirmed (revision_count
 * desc). Dynamic — newly-saved criteria show up without a reinstall.
 */

import type { ToolDefinition } from "./_types.js";
import { text } from "./_types.js";

/**
 * Canonical personas that ship with libreta. A criterion bucket is keyed by
 * one of these; an unknown persona is rejected so a typo can't silently return
 * an empty list forever.
 */
export const CANONICAL_PERSONAS: readonly string[] = [
  "lite",
  "coder",
  "arquitecto",
  "investigador",
  "revisor",
];

interface LibCriteriaArgs {
  persona: string;
  project?: string;
}

export const libCriteriaTool: ToolDefinition<LibCriteriaArgs> = {
  name: "lib_criteria",
  description:
    "Get a persona's personal validation criteria (how THIS user defines 'done' for that persona), ranked most-confirmed first. Consult it before validating or signing off a result.",
  inputSchema: {
    type: "object",
    properties: {
      persona: {
        type: "string",
        enum: [...CANONICAL_PERSONAS],
        description: "Canonical persona whose criteria to read",
      },
      project: {
        type: "string",
        description: "Optional project scope (omit to read across all projects)",
      },
    },
    required: ["persona"],
  },
  handler: async (args, db) => {
    if (typeof args.persona !== "string" || args.persona.trim() === "") {
      throw new Error("persona is required.");
    }
    if (!CANONICAL_PERSONAS.includes(args.persona)) {
      throw new Error(
        `Unknown persona "${args.persona}". Must be one of: ${CANONICAL_PERSONAS.join(", ")}.`,
      );
    }
    const criteria = db.listCriteria(args.persona, args.project);
    return text({ criteria });
  },
};
