/**
 * Offline reader over the on-disk Claude Code transcripts.
 *
 * Why one turn is one `message.id` and not one JSONL line, and why a shape
 * mismatch produces a gap instead of a zero:
 * the telemetry design notes, Decisions 1
 * and 5.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ContentBlock,
  DelegationRead,
  Gap,
  SessionRead,
  Turn,
  UsageTotals,
} from "./types.js";

const ZERO_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
  thinkingMeasured: null,
};

interface RawUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens_details?: { thinking_tokens?: unknown };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toUsage(raw: RawUsage): UsageTotals {
  const thinking = raw.output_tokens_details?.thinking_tokens;
  return {
    input: num(raw.input_tokens),
    output: num(raw.output_tokens),
    cacheCreation: num(raw.cache_creation_input_tokens),
    cacheRead: num(raw.cache_read_input_tokens),
    thinkingMeasured: typeof thinking === "number" ? thinking : null,
  };
}

export interface ParsedTranscript {
  readonly turns: readonly Turn[];
  readonly corruptLines: number;
  /** Wall time between the first and last timestamped line, or null if none carry one. */
  readonly durationMs: number | null;
}

/**
 * Parse a transcript body into turns.
 *
 * A streamed assistant message is written across several JSONL lines that all
 * share one `message.id`; each line repeats a partial `usage`. The last line
 * of an id carries the final figures, so the usage is taken from the last
 * occurrence and the content blocks are concatenated across all of them.
 */
export function parseTurns(content: string): ParsedTranscript {
  const byId = new Map<string, { model: string; usage: UsageTotals; blocks: ContentBlock[] }>();
  let corruptLines = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let entry: {
      type?: unknown;
      timestamp?: unknown;
      message?: { id?: unknown; model?: unknown; content?: unknown; usage?: RawUsage };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      corruptLines += 1;
      continue;
    }
    if (typeof entry.timestamp === "string") {
      const ms = Date.parse(entry.timestamp);
      if (Number.isFinite(ms)) {
        if (firstTs === null || ms < firstTs) firstTs = ms;
        if (lastTs === null || ms > lastTs) lastTs = ms;
      }
    }
    if (entry.type !== "assistant") continue;
    const message = entry.message;
    if (!message || typeof message.id !== "string" || !message.usage) continue;

    const blocks = Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
    const existing = byId.get(message.id);
    if (existing) {
      existing.usage = toUsage(message.usage);
      existing.blocks.push(...blocks);
    } else {
      byId.set(message.id, {
        model: typeof message.model === "string" ? message.model : "unknown",
        usage: toUsage(message.usage),
        blocks: [...blocks],
      });
    }
  }

  const turns: Turn[] = [];
  for (const [messageId, t] of byId) {
    turns.push({ messageId, model: t.model, usage: t.usage, blocks: t.blocks });
  }
  return {
    turns,
    corruptLines,
    durationMs: firstTs === null || lastTs === null ? null : lastTs - firstTs,
  };
}

/** Billed tokens of one UTC day: the four metered components, plus output on its own. */
export interface DailyBilled {
  billed: number;
  output: number;
}

export interface DailyBilledRead {
  /** Key is the `YYYY-MM-DD` UTC day of the turn's last line. */
  readonly byDay: ReadonlyMap<string, DailyBilled>;
  /** Outer key is the UTC day, inner key the turn's `message.model`. */
  readonly byDayModel: ReadonlyMap<string, ReadonlyMap<string, DailyBilled>>;
  /** Turns whose lines carried no parsable timestamp. Never folded into a day. */
  readonly turnsWithoutDate: number;
  /** Dated turns whose `message.model` was absent. In `byDay`, never in `byDayModel`. */
  readonly turnsWithoutModel: number;
  readonly corruptLines: number;
}

/**
 * Bucket a transcript's billed tokens by UTC day, one usage per `message.id`.
 *
 * A streamed message is attributed to the day of its last line, the same line
 * whose `usage` carries the final figures.
 */
export function parseDailyBilled(content: string): DailyBilledRead {
  const byId = new Map<string, { usage: UsageTotals; day: string | null; model: string | null }>();
  let corruptLines = 0;

  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let entry: {
      type?: unknown;
      timestamp?: unknown;
      message?: { id?: unknown; model?: unknown; usage?: RawUsage };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      corruptLines += 1;
      continue;
    }
    if (entry.type !== "assistant") continue;
    const message = entry.message;
    if (!message || typeof message.id !== "string" || !message.usage) continue;

    let day: string | null = null;
    if (typeof entry.timestamp === "string") {
      const ms = Date.parse(entry.timestamp);
      if (Number.isFinite(ms)) day = new Date(ms).toISOString().slice(0, 10);
    }
    const model = typeof message.model === "string" && message.model !== "" ? message.model : null;
    byId.set(message.id, { usage: toUsage(message.usage), day, model });
  }

  const byDay = new Map<string, DailyBilled>();
  const byDayModel = new Map<string, Map<string, DailyBilled>>();
  let turnsWithoutDate = 0;
  let turnsWithoutModel = 0;

  const fold = (into: Map<string, DailyBilled>, key: string, billed: number, output: number): void => {
    const bucket = into.get(key);
    if (bucket) {
      bucket.billed += billed;
      bucket.output += output;
    } else {
      into.set(key, { billed, output });
    }
  };

  for (const { usage, day, model } of byId.values()) {
    if (day === null) {
      turnsWithoutDate += 1;
      continue;
    }
    const billed = usage.input + usage.output + usage.cacheCreation + usage.cacheRead;
    fold(byDay, day, billed, usage.output);
    if (model === null) {
      turnsWithoutModel += 1;
      continue;
    }
    let models = byDayModel.get(day);
    if (!models) {
      models = new Map<string, DailyBilled>();
      byDayModel.set(day, models);
    }
    fold(models, model, billed, usage.output);
  }

  return { byDay, byDayModel, turnsWithoutDate, turnsWithoutModel, corruptLines };
}

/** Sum the four components over turns. `thinkingMeasured` stays null unless reported. */
export function sumTurns(turns: readonly Turn[]): UsageTotals {
  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let thinking: number | null = null;

  for (const t of turns) {
    input += t.usage.input;
    output += t.usage.output;
    cacheCreation += t.usage.cacheCreation;
    cacheRead += t.usage.cacheRead;
    if (t.usage.thinkingMeasured !== null) thinking = (thinking ?? 0) + t.usage.thinkingMeasured;
  }

  return { input, output, cacheCreation, cacheRead, thinkingMeasured: thinking };
}

/** `agent-<id>.jsonl` → `<id>`; anything else → null. */
export function agentIdFromPath(jsonlPath: string): string | null {
  const m = /^agent-(.+)\.jsonl$/.exec(basename(jsonlPath));
  return m ? m[1]! : null;
}

interface RawMeta {
  agentType?: unknown;
  description?: unknown;
  toolUseId?: unknown;
  spawnDepth?: unknown;
}

/** Read one `agent-<id>.jsonl` plus its `.meta.json`, or refuse with a gap. */
export function readDelegation(jsonlPath: string): DelegationRead | Gap {
  const agentId = agentIdFromPath(jsonlPath);

  let body: string;
  try {
    body = readFileSync(jsonlPath, "utf8");
  } catch (err) {
    return {
      kind: "gap",
      agentId,
      path: jsonlPath,
      reason: "unreadable-transcript",
      detail: (err as Error).message,
    };
  }

  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  let meta: RawMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as RawMeta;
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return {
      kind: "gap",
      agentId,
      path: jsonlPath,
      reason: missing ? "missing-meta" : "unreadable-meta",
      detail: (err as Error).message,
    };
  }

  const { turns, corruptLines, durationMs } = parseTurns(body);
  if (turns.length === 0) {
    return { kind: "gap", agentId, path: jsonlPath, reason: "missing-usage" };
  }

  return {
    kind: "delegation",
    agentId: agentId ?? "unknown",
    path: jsonlPath,
    agentType: typeof meta.agentType === "string" ? meta.agentType : "unknown",
    description: typeof meta.description === "string" ? meta.description : null,
    toolUseId: typeof meta.toolUseId === "string" ? meta.toolUseId : null,
    spawnDepth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : null,
    turns,
    totals: sumTurns(turns),
    durationMs,
    partial: corruptLines > 0,
    corruptLines,
  };
}

/** Read every `agent-*.jsonl` under `<sessionDir>/subagents/`. */
export function readSession(sessionDir: string): SessionRead {
  const sessionId = basename(sessionDir);
  const subagentsDir = join(sessionDir, "subagents");

  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch (err) {
    return {
      sessionId,
      delegations: [],
      gaps: [
        {
          kind: "gap",
          agentId: null,
          path: subagentsDir,
          reason: "unreadable-subagents-dir",
          detail: (err as Error).message,
        },
      ],
    };
  }

  const delegations: DelegationRead[] = [];
  const gaps: Gap[] = [];
  for (const name of entries.sort()) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    const read = readDelegation(join(subagentsDir, name));
    if (read.kind === "delegation") delegations.push(read);
    else gaps.push(read);
  }

  return { sessionId, delegations, gaps };
}

/** Totals of an empty read — exported so callers never hand-roll a zero literal. */
export function emptyTotals(): UsageTotals {
  return ZERO_TOTALS;
}
