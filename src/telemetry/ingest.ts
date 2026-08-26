/**
 * Ingest: reader + classifier + persistence, with every refusal declared.
 *
 * Why the main thread gets its own untasked row, and why a shape mismatch
 * yields a gap instead of a zero:
 * the telemetry design notes, Decisions 1
 * and 5.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LibretaDB } from "../storage/libreta-db.js";
import { classifyTurn, sumSplits, type ClassificationRules } from "./classify.js";
import { parseTurns, readSession, sumTurns } from "./transcript-reader.js";
import { taskTypeOf, type TaskTypePrefixes } from "./task-type.js";
import type { Gap, OutputSplit, TelemetryRow, Turn } from "./types.js";

/** Agent id and task type reserved for the orchestrator's own, unattributable spend. */
export const MAIN_AGENT_ID = "main";
export const MAIN_TASK_TYPE = "none";

/** Claude Code's on-disk name for a working directory. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeProjectsRoot(homeDir: string): string {
  return join(homeDir, ".claude", "projects");
}

/** Session ids under a project directory: every `<id>.jsonl` or `<id>/` present. */
export function listSessionIds(projectDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const name of entries) {
    if (name.endsWith(".jsonl")) {
      ids.add(name.slice(0, -".jsonl".length));
      continue;
    }
    try {
      if (statSync(join(projectDir, name)).isDirectory()) ids.add(name);
    } catch {
      /* skip an entry that vanished between readdir and stat */
    }
  }
  return [...ids].sort();
}

export interface IngestOptions {
  readonly rules?: ClassificationRules;
  readonly prefixes?: TaskTypePrefixes;
}

export interface SessionRows {
  readonly rows: readonly TelemetryRow[];
  readonly gaps: readonly Gap[];
}

function groupByModel(turns: readonly Turn[]): Map<string, Turn[]> {
  const byModel = new Map<string, Turn[]>();
  for (const t of turns) {
    const bucket = byModel.get(t.model);
    if (bucket) bucket.push(t);
    else byModel.set(t.model, [t]);
  }
  return byModel;
}

function splitOf(turns: readonly Turn[], rules?: ClassificationRules): OutputSplit {
  return sumSplits(turns.map((t) => classifyTurn(t, rules)));
}

function countToolUseBlocks(turns: readonly Turn[]): number {
  let count = 0;
  for (const t of turns) {
    for (const b of t.blocks) if (b.type === "tool_use") count += 1;
  }
  return count;
}

function rowOf(args: {
  sessionId: string;
  agentId: string;
  model: string;
  agent: string;
  taskType: string;
  description: string | null;
  toolUseId: string | null;
  spawnDepth: number | null;
  durationMs: number | null;
  turns: readonly Turn[];
  partial: boolean;
  ingestedAt: string;
  rules?: ClassificationRules;
}): TelemetryRow {
  const totals = sumTurns(args.turns);
  const split = splitOf(args.turns, args.rules);
  return {
    session_id: args.sessionId,
    agent_id: args.agentId,
    model: args.model,
    agent: args.agent,
    task_type: args.taskType,
    description: args.description,
    tool_use_id: args.toolUseId,
    spawn_depth: args.spawnDepth,
    duration_ms: args.durationMs,
    turns: args.turns.length,
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_creation_tokens: totals.cacheCreation,
    cache_read_tokens: totals.cacheRead,
    out_thinking: split.classes.thinking,
    out_prose: split.classes.prose,
    out_tool_call: split.classes.tool_call,
    out_code: split.classes.code,
    out_test: split.classes.test,
    out_doc: split.classes.doc,
    thinking_method: split.thinkingMethod,
    tool_calls: countToolUseBlocks(args.turns),
    partial: args.partial ? 1 : 0,
    ingested_at: args.ingestedAt,
  };
}

/** Main-thread turns: assistant turns of `<session>.jsonl` that are not sidechains. */
export function mainTurns(
  projectDir: string,
  sessionId: string,
): { turns: readonly Turn[]; partial: boolean; durationMs: number | null } | null {
  const path = join(projectDir, `${sessionId}.jsonl`);
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { turns, corruptLines, durationMs } = parseTurns(withoutSidechains(body));
  if (turns.length === 0) return null;
  return { turns, partial: corruptLines > 0, durationMs };
}

/** Drop the sub-agent turns a main transcript repeats, keeping every other line. */
export function withoutSidechains(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => {
      if (line.trim() === "") return false;
      try {
        const entry = JSON.parse(line) as { type?: unknown; isSidechain?: unknown };
        return entry.type !== "assistant" || entry.isSidechain !== true;
      } catch {
        return true;
      }
    })
    .join("\n");
}

/** Build the rows and gaps of one session without touching the DB. */
export function buildSessionRows(
  projectDir: string,
  sessionId: string,
  ingestedAt: string = new Date().toISOString(),
  options: IngestOptions = {},
): SessionRows {
  const session = readSession(join(projectDir, sessionId));
  const rows: TelemetryRow[] = [];

  for (const delegation of session.delegations) {
    for (const [model, turns] of groupByModel(delegation.turns)) {
      rows.push(
        rowOf({
          sessionId,
          agentId: delegation.agentId,
          model,
          agent: delegation.agentType,
          taskType: taskTypeOf(delegation.description, options.prefixes),
          description: delegation.description,
          toolUseId: delegation.toolUseId,
          spawnDepth: delegation.spawnDepth,
          durationMs: delegation.durationMs,
          turns,
          partial: delegation.partial,
          ingestedAt,
          ...(options.rules ? { rules: options.rules } : {}),
        }),
      );
    }
  }

  const main = mainTurns(projectDir, sessionId);
  if (main) {
    for (const [model, turns] of groupByModel(main.turns)) {
      rows.push(
        rowOf({
          sessionId,
          agentId: MAIN_AGENT_ID,
          model,
          agent: MAIN_AGENT_ID,
          taskType: MAIN_TASK_TYPE,
          description: null,
          toolUseId: null,
          spawnDepth: 0,
          durationMs: main.durationMs,
          turns,
          partial: main.partial,
          ingestedAt,
          ...(options.rules ? { rules: options.rules } : {}),
        }),
      );
    }
  }

  return { rows, gaps: session.gaps };
}

/** Build and persist one session's rows, replacing whatever was there before. */
export function ingestSession(
  db: LibretaDB,
  projectDir: string,
  sessionId: string,
  options: IngestOptions = {},
): SessionRows {
  const built = buildSessionRows(projectDir, sessionId, new Date().toISOString(), options);
  const { snapshotGap } = db.replaceSessionTelemetry(sessionId, built.rows);
  return snapshotGap ? { ...built, gaps: [...built.gaps, snapshotGap] } : built;
}
