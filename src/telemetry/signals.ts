/**
 * The team consumption signals of the team consumption playbook, computed over
 * what the telemetry capability already ingests.
 *
 * Which of them are measurable today, the chosen definition of "session
 * startup", and the datum each unmeasurable signal is missing:
 * the consumption-signals notes.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listSessionIds, mainTurns, withoutSidechains } from "./ingest.js";
import { parseDailyBilled } from "./transcript-reader.js";
import type { Turn } from "./types.js";

export const STARTUP_CEILING_TOKENS = 15_000;
export const CLAUDE_MD_CEILING_LINES = 200;
export const LONG_SESSION_MS = 4 * 60 * 60 * 1000;

/**
 * The definition of "session startup" this module measures, stated in every
 * report so the figure is comparable with the one the team reads off `/context`.
 */
export const STARTUP_DEFINITION =
  "arranque = prompt facturado del PRIMER turno assistant del hilo principal " +
  "(input + cache_creation + cache_read), antes de que el turno agregue historia. " +
  "Una sesión reanudada con --resume arranca con la historia previa adentro y su cifra no es un arranque limpio.";

/** What `tokens/día` means here, stated in every report. */
export const DAILY_DEFINITION =
  "día = día UTC del turno (última línea del message.id), y el total del día es el facturado " +
  "input + output + cache_creation + cache_read del hilo principal más el de cada sub-agente. " +
  "Los turnos sidechain del transcript principal no se cuentan dos veces: se leen del archivo del sub-agente.";

/** The part of the playbook metric this report cannot cover, published with the figure. */
export const DAILY_MISSING_PART =
  "el eje `por developer`. Los transcripts son los de ESTA máquina y este proyecto: no traen " +
  "identidad de developer, así que la serie es por proyecto/máquina y no se puede dividir por persona.";

/** The playbook's healthy signal for this metric is a trend, not a threshold. */
export const DAILY_SIGNAL_NOTE =
  "la señal saludable del playbook es «bajando o estable con más output»: es una tendencia sobre " +
  "dos variables, no un umbral. El reporte publica la serie y el output de cada día; no declara veredicto.";

/** Why the `CLAUDE.md` signal is published once and never split by model. */
export const CLAUDE_MD_MODEL_AGNOSTIC =
  "señal agnóstica al modelo: son archivos en disco, y en disco no hay ninguna atribución de modelo " +
  "para una línea de CLAUDE.md. Cortarla por modelo sería inventar una dimensión que el dato no tiene.";

/** Why the long-session signal is published once and never split by model. */
export const LONG_SESSION_MODEL_AGNOSTIC =
  "señal agnóstica al modelo: la duración es tiempo de pared de un transcript que puede cruzar modelos " +
  "a mitad de sesión, y en disco no hay reparto de ese tiempo por modelo.";

/** Dated turns whose transcript carried no `message.model`, stated with the per-model cut. */
export const DAILY_MODEL_GAP =
  "turno(s) con fecha pero sin `message.model` en el transcript: entran en el total del día y quedan " +
  "fuera del corte por modelo, nunca repartidos entre los modelos que sí lo traen.";

/** Sessions whose first main turn carried no model, stated with the per-model startup cut. */
export const STARTUP_MODEL_GAP =
  "sesión(es) sin modelo en el primer turno principal: quedan fuera del corte por modelo, " +
  "sin repartirse ni contarse bajo ninguno.";

export interface DailyTokens {
  readonly day: string;
  readonly billedTokens: number;
  readonly outputTokens: number;
}

/** One day's billed tokens for one model. Days do not sum to the day total when a turn lacks a model. */
export interface DailyTokensByModel extends DailyTokens {
  readonly model: string;
}

export interface DailyTokensSummary {
  readonly days: readonly DailyTokens[];
  readonly daysByModel: readonly DailyTokensByModel[];
  readonly transcriptsRead: number;
  readonly turnsWithoutDate: number;
  readonly turnsWithoutModel: number;
  readonly corruptLines: number;
  readonly definition: string;
  readonly missingPart: string;
  readonly signalNote: string;
}

export interface SessionStartup {
  readonly sessionId: string;
  readonly startupTokens: number | null;
  readonly durationMs: number | null;
  /** Model of the first main turn, or null when there is no turn to read it from. */
  readonly model: string | null;
}

export interface StartupSummary {
  readonly ceiling: number;
  readonly sessionsMeasured: number;
  readonly sessionsUnread: number;
  readonly under: number;
  readonly over: number;
  readonly median: number | null;
  readonly max: number | null;
  readonly definition: string;
}

/** The startup summary of the sessions whose first main turn ran on this model. */
export interface StartupByModel extends StartupSummary {
  readonly model: string;
}

export interface LongSessionSummary {
  readonly thresholdMs: number;
  readonly sessionsMeasured: number;
  readonly sessionsUnread: number;
  readonly over: number;
  readonly longestMs: number | null;
}

export type ClaudeMdScope = "user" | "project" | "project-local";

export interface ClaudeMdFile {
  readonly scope: ClaudeMdScope;
  readonly path: string;
  readonly present: boolean;
  readonly lines: number | null;
  readonly overCeiling: boolean;
}

export interface UnmeasurableSignal {
  readonly id: string;
  readonly signal: string;
  readonly missing: string;
  readonly source: string;
}

export const UNMEASURABLE_SIGNALS: readonly UnmeasurableSignal[] = [
  {
    id: "mcp-spend-share",
    signal: "% de gasto atribuido a MCP por debajo del 15%",
    missing:
      "el desglose por sección del prompt de sistema. El transcript trae un único " +
      "cache_creation_input_tokens agregado: las definiciones de herramienta MCP viajan adentro " +
      "de ese número y no se pueden separar del resto del prompt. Los tool_result de MCP tampoco " +
      "se miden aparte: son contenido de mensajes user, sin usage propio.",
    source:
      "`/usage` de Claude Code, que atribuye gasto por servidor MCP. No hay volcado a disco de esa " +
      "atribución; haría falta que Claude Code la persista, o un contador propio en el borde MCP.",
  },
  {
    id: "rework-after-degradation",
    signal: "re-trabajo por output degradado, sin cambios (si sube, revertí ajustes)",
    missing:
      "el juicio de qué output fue degradado y qué trabajo fue re-trabajo. El playbook le pone " +
      "fuente `Retro`, o sea humana: en disco no hay ninguna marca que distinga un segundo intento " +
      "por output malo de un segundo intento por un pedido nuevo. Un proxy por rondas de gate " +
      "mediría otra cosa y no se declara como esta métrica.",
    source: "la retro del equipo. No es instrumentable con transcripts.",
  },
  {
    id: "cost-per-merged-pr",
    signal: "costo por PR mergeado, bajando",
    missing:
      "el denominador: la cantidad de PRs mergeados por período. La telemetría no tiene noción de " +
      "PR, y este repo trabaja local sin PRs. El numerador tampoco es gratis: exige una tabla de " +
      "precios (`tokens report --prices`), sin la cual no se declara costo.",
    source:
      "git/GitHub (`gh pr list --state merged`), cruzado por fecha contra `ingested_at` de la serie.",
  },
];

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function subagentTranscripts(projectDir: string, sessionId: string): readonly string[] {
  const dir = join(projectDir, sessionId, "subagents");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(dir, name));
}

/** Billed tokens per UTC day over every transcript of a project, main plus sub-agents. */
export function readDailyTokens(projectDir: string): DailyTokensSummary {
  const byDay = new Map<string, { billed: number; output: number }>();
  const byDayModel = new Map<string, { day: string; model: string; billed: number; output: number }>();
  let transcriptsRead = 0;
  let turnsWithoutDate = 0;
  let turnsWithoutModel = 0;
  let corruptLines = 0;

  const add = (
    into: Map<string, { billed: number; output: number }>,
    key: string,
    totals: { billed: number; output: number },
  ): void => {
    const bucket = into.get(key);
    if (bucket) {
      bucket.billed += totals.billed;
      bucket.output += totals.output;
    } else {
      into.set(key, { billed: totals.billed, output: totals.output });
    }
  };

  const fold = (content: string): void => {
    transcriptsRead += 1;
    const read = parseDailyBilled(content);
    turnsWithoutDate += read.turnsWithoutDate;
    turnsWithoutModel += read.turnsWithoutModel;
    corruptLines += read.corruptLines;
    for (const [day, totals] of read.byDay) add(byDay, day, totals);
    for (const [day, models] of read.byDayModel) {
      for (const [model, totals] of models) {
        const key = `${day}|${model}`;
        const bucket = byDayModel.get(key);
        if (bucket) {
          bucket.billed += totals.billed;
          bucket.output += totals.output;
        } else {
          byDayModel.set(key, { day, model, billed: totals.billed, output: totals.output });
        }
      }
    }
  };

  for (const sessionId of listSessionIds(projectDir)) {
    const main = readIfPresent(join(projectDir, `${sessionId}.jsonl`));
    if (main !== null) fold(withoutSidechains(main));
    for (const path of subagentTranscripts(projectDir, sessionId)) {
      const body = readIfPresent(path);
      if (body !== null) fold(body);
    }
  }

  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, totals]) => ({
      day,
      billedTokens: totals.billed,
      outputTokens: totals.output,
    }));

  const daysByModel = [...byDayModel.values()]
    .sort((a, b) => (a.day === b.day ? a.model.localeCompare(b.model) : a.day < b.day ? -1 : 1))
    .map(({ day, model, billed, output }) => ({
      day,
      model,
      billedTokens: billed,
      outputTokens: output,
    }));

  return {
    days,
    daysByModel,
    transcriptsRead,
    turnsWithoutDate,
    turnsWithoutModel,
    corruptLines,
    definition: DAILY_DEFINITION,
    missingPart: DAILY_MISSING_PART,
    signalNote: DAILY_SIGNAL_NOTE,
  };
}

/** The billed prompt of the first turn, or null when there is no turn to read. */
export function startupTokensOf(turns: readonly Turn[]): number | null {
  const first = turns[0];
  if (!first) return null;
  return first.usage.input + first.usage.cacheCreation + first.usage.cacheRead;
}

/** The model of the first main turn, or null when there is no turn to read it from. */
export function startupModelOf(turns: readonly Turn[]): string | null {
  const first = turns[0];
  if (!first || first.model === "" || first.model === "unknown") return null;
  return first.model;
}

/** Startup size and wall time of every session transcript under a project directory. */
export function readSessionStartups(projectDir: string): readonly SessionStartup[] {
  return listSessionIds(projectDir).map((sessionId) => {
    const main = mainTurns(projectDir, sessionId);
    if (!main) return { sessionId, startupTokens: null, durationMs: null, model: null };
    return {
      sessionId,
      startupTokens: startupTokensOf(main.turns),
      durationMs: main.durationMs,
      model: startupModelOf(main.turns),
    };
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summariseStartup(sessions: readonly SessionStartup[]): StartupSummary {
  const measured = sessions
    .map((s) => s.startupTokens)
    .filter((t): t is number => t !== null);
  return {
    ceiling: STARTUP_CEILING_TOKENS,
    sessionsMeasured: measured.length,
    sessionsUnread: sessions.length - measured.length,
    under: measured.filter((t) => t < STARTUP_CEILING_TOKENS).length,
    over: measured.filter((t) => t >= STARTUP_CEILING_TOKENS).length,
    median: median(measured),
    max: measured.length === 0 ? null : Math.max(...measured),
    definition: STARTUP_DEFINITION,
  };
}

/** One startup summary per model of a first main turn. Sessions without one are excluded. */
export function summariseStartupByModel(sessions: readonly SessionStartup[]): readonly StartupByModel[] {
  const byModel = new Map<string, SessionStartup[]>();
  for (const s of sessions) {
    if (s.model === null) continue;
    const bucket = byModel.get(s.model);
    if (bucket) bucket.push(s);
    else byModel.set(s.model, [s]);
  }
  return [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, group]) => ({ model, ...summariseStartup(group) }));
}

/** Sessions whose first main turn carried no model, so they sit outside the per-model cut. */
export function countSessionsWithoutModel(sessions: readonly SessionStartup[]): number {
  return sessions.filter((s) => s.model === null).length;
}

export function summariseLongSessions(sessions: readonly SessionStartup[]): LongSessionSummary {
  const measured = sessions.map((s) => s.durationMs).filter((d): d is number => d !== null);
  return {
    thresholdMs: LONG_SESSION_MS,
    sessionsMeasured: measured.length,
    sessionsUnread: sessions.length - measured.length,
    over: measured.filter((d) => d > LONG_SESSION_MS).length,
    longestMs: measured.length === 0 ? null : Math.max(...measured),
  };
}

function countLines(path: string): number {
  const body = readFileSync(path, "utf8");
  if (body === "") return 0;
  return body.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Every CLAUDE.md that Claude Code loads into context, with its line count. */
export function readClaudeMdFiles(homeDir: string, projectDir: string): readonly ClaudeMdFile[] {
  const candidates: readonly { scope: ClaudeMdScope; path: string }[] = [
    { scope: "user", path: join(homeDir, ".claude", "CLAUDE.md") },
    { scope: "project", path: join(projectDir, "CLAUDE.md") },
    { scope: "project-local", path: join(projectDir, "CLAUDE.local.md") },
  ];

  return candidates.map(({ scope, path }) => {
    if (!existsSync(path)) {
      return { scope, path, present: false, lines: null, overCeiling: false };
    }
    const lines = countLines(path);
    return { scope, path, present: true, lines, overCeiling: lines > CLAUDE_MD_CEILING_LINES };
  });
}

export interface SignalsReport {
  readonly projectDir: string;
  readonly sessions: readonly SessionStartup[];
  readonly startup: StartupSummary;
  readonly startupByModel: readonly StartupByModel[];
  readonly sessionsWithoutModel: number;
  readonly longSessions: LongSessionSummary;
  readonly claudeMd: readonly ClaudeMdFile[];
  readonly daily: DailyTokensSummary;
  readonly unmeasurable: readonly UnmeasurableSignal[];
}

export function buildSignalsReport(
  transcriptsDir: string,
  homeDir: string,
  projectDir: string,
): SignalsReport {
  const sessions = readSessionStartups(transcriptsDir);
  return {
    projectDir: transcriptsDir,
    sessions,
    startup: summariseStartup(sessions),
    startupByModel: summariseStartupByModel(sessions),
    sessionsWithoutModel: countSessionsWithoutModel(sessions),
    longSessions: summariseLongSessions(sessions),
    claudeMd: readClaudeMdFiles(homeDir, projectDir),
    daily: readDailyTokens(transcriptsDir),
    unmeasurable: UNMEASURABLE_SIGNALS,
  };
}
