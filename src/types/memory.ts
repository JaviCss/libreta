/**
 * Memory types for the libreta component.
 *
 * Modeled after Gentleman-Programming/engram's schema, simplified for
 * our v0.1 scope (no cloud sync, no conflict judging, no scope/visibility
 * layer). `where` is a TS field that maps to `where_` in SQLite (where
 * is a reserved word).
 */

export type ObservationType =
  | "architecture" // design decisions
  | "decision" // why we chose X over Y
  | "bugfix" // how we fixed something
  | "pattern" // recurring pattern in the codebase
  | "learning" // general learning
  | "gotcha" // trap to avoid
  | "preference"; // user/team preference

export const OBSERVATION_TYPES: readonly ObservationType[] = [
  "architecture",
  "decision",
  "bugfix",
  "pattern",
  "learning",
  "gotcha",
  "preference",
];

export interface Observation {
  /** ULID — lexicographically sortable. */
  id: string;
  /** Project name, e.g. "libreta". */
  project: string;
  /** Optional session this observation belongs to. */
  session_id?: string;
  /** Optional key for grouping related observations (e.g. "memory-impl"). */
  topic_key?: string;
  /** Short title (one line). */
  title: string;
  /** Category. */
  type: ObservationType;
  /** What happened / was done. */
  what: string;
  /** Why this approach. */
  why: string;
  /** File path / function / commit / URL reference. */
  where: string;
  /** Takeaway for the future. */
  learned: string;
  /**
   * Deterministic sha256 (hex) of the content fields — the dedup key. Internal:
   * populated by storage, not supplied by callers of save(). Optional on the
   * type so input shapes (Omit id/created_at/updated_at) don't require it.
   */
  content_hash?: string;
  /**
   * How many times this exact content has been saved into its dedup bucket.
   * Starts at 1; a re-save of identical content bumps it instead of inserting
   * a duplicate row. Always present on rows read back from storage.
   */
  revision_count: number;
  /** ISO 8601 timestamp. */
  created_at: string;
  /** ISO 8601 timestamp. */
  updated_at: string;
}

/**
 * A bitácora entry: a day-level executive index of what was done, distinct
 * from an observation. Deliberately carries NO why/where/learned — it is a
 * "supercalendario" to skim, and MAY link to the observations of that day
 * (their ids) so the index can drill into the detail.
 */
export interface BitacoraEntry {
  /** ULID — lexicographically sortable. */
  id: string;
  /** Project name, e.g. "libreta". */
  project: string;
  /** The day this entry summarizes (ISO date, e.g. "2026-07-21"). */
  date: string;
  /** One-line executive headline for the day. */
  headline: string;
  /** The day's executive summary (may be multi-paragraph). */
  summary: string;
  /** ids of the observations of that day this entry indexes (may be empty). */
  linked_ids: string[];
  /** ISO 8601 timestamp of when the entry was recorded. */
  created_at: string;
}

/** Options accepted by LibretaDB.bitacoraRange. */
export interface BitacoraRangeOptions {
  limit?: number;
}

export interface Session {
  id: string;
  project: string;
  started_at: string;
  ended_at?: string;
  summary?: string;
  observation_count: number;
}

export interface SearchResult {
  observation: Observation;
  /** FTS5 bm25 score — smaller is a better match. */
  score: number;
  /** Highlighted excerpt with `<mark>` tags around matched terms. */
  snippet: string;
}

/** Options accepted by LibretaDB.search. */
export interface SearchOptions {
  project?: string;
  type?: ObservationType;
  limit?: number;
}

/** Options accepted by LibretaDB.list. */
export interface ListOptions {
  project?: string;
  session_id?: string;
  limit?: number;
  offset?: number;
}

/** Result of a LibretaDB.exportAll() call. */
export interface ExportPayload {
  version: 1;
  exported_at: string;
  observations: Observation[];
  sessions: Session[];
}

/** Database health report from LibretaDB.doctor(). */
export interface DoctorReport {
  ok: boolean;
  issues: string[];
}

/**
 * Closed vocabulary of relation labels that mem_judge can record between two
 * observations (change `mem-judge`, Part B). Frozen — adding a value changes
 * the meaning of stored verdicts. Stored verbatim in `observation_relations.relation`.
 */
export type Relation =
  | "conflicts_with" // contradictory claims
  | "supersedes" // one replaces/overrides the other (directional)
  | "scoped" // one is a narrower instance of the other
  | "related" // same topic, no conflict
  | "compatible" // consistent and complementary
  | "not_conflict"; // unrelated, no meaningful overlap

export const RELATIONS: readonly Relation[] = [
  "conflicts_with",
  "supersedes",
  "scoped",
  "related",
  "compatible",
  "not_conflict",
];

/** Options accepted by LibretaDB.findCandidates. */
export interface FindCandidatesOptions {
  /**
   * BM25 relevance floor. SQLite FTS5 returns negative numbers for matches
   * (smaller = more relevant). Only matches with `score <= floor` are kept,
   * so a more-negative floor is STRICTER (filters more aggressively).
   *
   * Default: `0.0` (no filtering — accepts every FTS5 hit). Rationale:
   * bm25 magnitudes are corpus-dependent. With a small/empty FTS5 corpus
   * the raw scores are tiny (e.g. `-1e-6`); a fixed default like the
   * design.md's `-2.0` would silently reject every match on a fresh DB
   * and hide near-duplicates from the user. `0.0` keeps the advisory
   * finder surface-relevant from day one. Power users (or a future Lote)
   * can tighten via `floor: -0.5` / `-2.0` etc.
   */
  floor?: number;
  /** Max candidates returned. Default: 3. */
  limit?: number;
}

/** A candidate surfaced by the deterministic candidate finder (FTS5, no LLM). */
export interface CandidateMatch {
  /** The candidate observation. */
  observation: Observation;
  /**
   * FTS5 bm25 score. SQLite FTS5 returns negative numbers — smaller (more
   * negative) is more relevant. `ORDER BY score` is ascending, so the first
   * candidate is the most relevant.
   */
  score: number;
}

/**
 * The verdict as it sits in `observation_relations`. Mirrors the public
 * `Verdict` from `src/mem-judge/types.ts` plus the audit timestamps. The
 * storage layer treats this as the on-disk shape; the orchestrator converts
 * to/from the public shape at the boundary.
 */
export interface StoredVerdict {
  obs_a_id: string;
  obs_b_id: string;
  /** Closed vocab (Lote 2). */
  relation: Relation;
  /** Real number in [0, 1]. */
  confidence: number;
  /** Short human-readable rationale, ≤ 200 chars (parser-enforced in Lote 2). */
  reasoning: string;
  /** ISO 8601, UTC — the FIRST time this pair was judged. */
  created_at: string;
  /** ISO 8601, UTC — the LAST time the verdict was overwritten (re-judge). */
  updated_at: string;
}