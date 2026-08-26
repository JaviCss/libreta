/**
 * SQLite-backed storage for the libreta memory component.
 *
 * Schema mirrors engram's mental model:
 *   - observations: append-mostly, immutable content + mutable timestamps
 *   - sessions: groups of observations, for "review this session" workflows
 *   - observations_fts: FTS5 mirror kept in sync via triggers
 *
 * All methods are synchronous (better-sqlite3 is sync). Async signatures
 * are kept for forward compatibility with a potential future async driver.
 */

import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { ulid, monotonicFactory } from "ulid";
import Database from "better-sqlite3";
import { isWindows } from "../utils/platform.js";
import { contentHash } from "./content-hash.js";
import type {
  BitacoraEntry,
  BitacoraRangeOptions,
  CandidateMatch,
  DoctorReport,
  ExportPayload,
  FindCandidatesOptions,
  ListOptions,
  Observation,
  ObservationType,
  Relation,
  SearchOptions,
  SearchResult,
  Session,
  StoredVerdict,
} from "../types/memory.js";
import type { Verdict } from "../mem-judge/types.js";
import type {
  TelemetryAxis,
  TelemetryFilter,
  TelemetryGroup,
  TelemetryRow,
  TelemetryVolumeGroup,
  ReportGap,
  Gap,
  GapReason,
  OutputClass,
  SnapshotAxis,
  TelemetrySnapshotRow,
  TelemetrySnapshotTotalRow,
  TelemetrySnapshotOutputClassRow,
  TelemetrySnapshotNoteRow,
  ComparableSnapshotGroup,
} from "../telemetry/types.js";
import { TELEMETRY_AXES, VOLUME_KEY_SEPARATOR } from "../telemetry/types.js";

const monotonicUlid = monotonicFactory();

/** Fixed order the six output classes are captured in — design.md Decision 1/3. */
const OUTPUT_CLASSES: readonly OutputClass[] = [
  "thinking",
  "prose",
  "tool_call",
  "code",
  "test",
  "doc",
];

/** One (snapshot × axis × group)'s aggregate, before it is written to the two measurement tables. */
interface SnapshotGroupAggregate {
  readonly key: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
  readonly turns: number;
  readonly sessions: number;
  readonly tool_calls: number | null;
  readonly tool_calls_gap: GapReason | null;
  readonly class_totals: Readonly<Record<OutputClass, number>>;
  readonly measured_share: number;
}

/** Aggregate one axis-group's rows into its snapshot totals and class split — design.md Decision 3/4. */
function aggregateSnapshotGroup(rows: readonly TelemetryRow[], key: string): SnapshotGroupAggregate {
  const classTotals: Record<OutputClass, number> = {
    thinking: 0,
    prose: 0,
    tool_call: 0,
    code: 0,
    test: 0,
    doc: 0,
  };
  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let turns = 0;
  let toolCallsSum = 0;
  let toolCallsGapped = false;
  let measuredOutput = 0;
  const sessionIds = new Set<string>();

  for (const r of rows) {
    input += r.input_tokens;
    output += r.output_tokens;
    cacheCreation += r.cache_creation_tokens;
    cacheRead += r.cache_read_tokens;
    turns += r.turns;
    classTotals.thinking += r.out_thinking;
    classTotals.prose += r.out_prose;
    classTotals.tool_call += r.out_tool_call;
    classTotals.code += r.out_code;
    classTotals.test += r.out_test;
    classTotals.doc += r.out_doc;
    sessionIds.add(r.session_id);
    if (r.tool_calls === null) toolCallsGapped = true;
    else toolCallsSum += r.tool_calls;
    if (r.thinking_method === "measured") measuredOutput += r.output_tokens;
  }

  return {
    key,
    input_tokens: input,
    output_tokens: output,
    cache_creation_tokens: cacheCreation,
    cache_read_tokens: cacheRead,
    turns,
    sessions: sessionIds.size,
    tool_calls: toolCallsGapped ? null : toolCallsSum,
    tool_calls_gap: toolCallsGapped ? "tool-calls-not-counted" : null,
    class_totals: classTotals,
    measured_share: output > 0 ? measuredOutput / output : 0,
  };
}

/** One (axis, group) sorted onto a stable key, for byte-identical dedup comparisons. */
type CanonicalSnapshotGroup = ComparableSnapshotGroup;

function compareCanonicalGroups(a: CanonicalSnapshotGroup, b: CanonicalSnapshotGroup): number {
  return a.axis === b.axis ? a.key.localeCompare(b.key) : a.axis.localeCompare(b.axis);
}

/** Canonicalize a freshly computed aggregate, sorted so group insertion order cannot affect the comparison. */
function canonicalizeAggregate(
  axisGroups: ReadonlyArray<{ axis: SnapshotAxis; groups: readonly SnapshotGroupAggregate[] }>,
): CanonicalSnapshotGroup[] {
  const list: CanonicalSnapshotGroup[] = [];
  for (const { axis, groups } of axisGroups) {
    for (const g of groups) {
      list.push({
        axis,
        key: g.key,
        input_tokens: g.input_tokens,
        output_tokens: g.output_tokens,
        cache_creation_tokens: g.cache_creation_tokens,
        cache_read_tokens: g.cache_read_tokens,
        turns: g.turns,
        sessions: g.sessions,
        tool_calls: g.tool_calls,
        tool_calls_gap: g.tool_calls_gap,
        classes: g.class_totals,
        measured_share: g.measured_share,
      });
    }
  }
  return list.sort(compareCanonicalGroups);
}

/** Every axis of a pre-replace snapshot (`total` plus the three groupable axes) — design.md Decision 2/3. */
function snapshotAxisGroups(
  rows: readonly TelemetryRow[],
): ReadonlyArray<{ axis: SnapshotAxis; groups: readonly SnapshotGroupAggregate[] }> {
  const result: Array<{ axis: SnapshotAxis; groups: readonly SnapshotGroupAggregate[] }> = [
    { axis: "total", groups: [aggregateSnapshotGroup(rows, "")] },
  ];
  for (const axis of TELEMETRY_AXES.filter((a): a is Exclude<TelemetryAxis, "session_id"> => a !== "session_id")) {
    const byKey = new Map<string, TelemetryRow[]>();
    for (const r of rows) {
      const k = String(r[axis]);
      const arr = byKey.get(k);
      if (arr) arr.push(r);
      else byKey.set(k, [r]);
    }
    result.push({
      axis,
      groups: [...byKey.entries()].map(([k, rs]) => aggregateSnapshotGroup(rs, k)),
    });
  }
  return result;
}

interface ObservationRow {
  id: string;
  project: string;
  session_id: string | null;
  topic_key: string | null;
  title: string;
  type: string;
  what: string;
  why: string;
  where_: string;
  learned: string;
  content_hash: string | null;
  revision_count: number;
  created_at: string;
  updated_at: string;
}

interface BitacoraRow {
  id: string;
  project: string;
  date: string;
  headline: string;
  summary: string;
  linked_ids: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  project: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  observation_count: number;
}

function rowToObservation(row: ObservationRow): Observation {
  const obs: Observation = {
    id: row.id,
    project: row.project,
    title: row.title,
    type: row.type as ObservationType,
    what: row.what,
    why: row.why,
    where: row.where_,
    learned: row.learned,
    revision_count: row.revision_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.session_id !== null) obs.session_id = row.session_id;
  if (row.topic_key !== null) obs.topic_key = row.topic_key;
  if (row.content_hash !== null) obs.content_hash = row.content_hash;
  return obs;
}

function rowToBitacora(row: BitacoraRow): BitacoraEntry {
  let linked_ids: string[] = [];
  try {
    const parsed = JSON.parse(row.linked_ids) as unknown;
    if (Array.isArray(parsed)) linked_ids = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // Corrupt/legacy value — degrade to an empty link list rather than throw.
    linked_ids = [];
  }
  return {
    id: row.id,
    project: row.project,
    date: row.date,
    headline: row.headline,
    summary: row.summary,
    linked_ids,
    created_at: row.created_at,
  };
}

function rowToSession(row: SessionRow): Session {
  const s: Session = {
    id: row.id,
    project: row.project,
    started_at: row.started_at,
    observation_count: row.observation_count,
  };
  if (row.ended_at !== null) s.ended_at = row.ended_at;
  if (row.summary !== null) s.summary = row.summary;
  return s;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  session_id TEXT,
  topic_key TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  what TEXT NOT NULL,
  why TEXT NOT NULL,
  where_ TEXT NOT NULL,
  learned TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_topic ON observations(topic_key);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, what, why, learned, where_,
  content='observations',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, what, why, learned, where_)
  VALUES (new.rowid, new.title, new.what, new.why, new.learned, new.where_);
END;
CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, what, why, learned, where_)
  VALUES('delete', old.rowid, old.title, old.what, old.why, old.learned, old.where_);
END;
CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, what, why, learned, where_)
  VALUES('delete', old.rowid, old.title, old.what, old.why, old.learned, old.where_);
  INSERT INTO observations_fts(rowid, title, what, why, learned, where_)
  VALUES (new.rowid, new.title, new.what, new.why, new.learned, new.where_);
END;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`;

/**
 * Schema for the bitácora — a day-level executive index, added in schema v2.
 * Deliberately a DIFFERENT shape from observations: no why/where/learned, just
 * a headline + summary per day and the observation ids it indexes (stored as a
 * JSON text array). Entirely CREATE ... IF NOT EXISTS so the migration is a
 * true no-op on a DB that already has it.
 */
export const BITACORA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bitacora (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  date TEXT NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  linked_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bitacora_project_date ON bitacora(project, date);
`;

/**
 * Schema for the mem_judge relations/verdicts table — added in schema v4.
 *
 * One row per (obs_a_id, obs_b_id) PAIR. PRIMARY KEY (obs_a_id, obs_b_id) is
 * the canonical SQLite way to encode "unique pair, no surrogate id", and it
 * gives us UPSERT-on-rejudge semantics "for free" via `INSERT ... ON CONFLICT`
 * (runner, Lote 2). Non-destructive: only CREATE ... IF NOT EXISTS, no
 * touches to observations / sessions / bitacora.
 *
 * No FOREIGN KEY constraints on obs_a_id / obs_b_id: mem_judge is advisory
 * and reversible, so the verdict history MUST survive a hard-delete of an
 * observation if the user ever takes that path (not the apply path — the
 * apply path uses soft marks — but we do not want a future cascade to wipe
 * verdict history silently).
 */
export const OBSERVATION_RELATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observation_relations (
  obs_a_id TEXT NOT NULL,
  obs_b_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL,
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (obs_a_id, obs_b_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_a ON observation_relations(obs_a_id);
CREATE INDEX IF NOT EXISTS idx_rel_b ON observation_relations(obs_b_id);
`;

/**
 * Schema for the soft-deprecate flag — added in schema v5 (mem_judge Lote 3).
 *
 * `deprecated` is the user-facing "this criterion lost authority" marker that
 * `memory judge --apply` sets on observations involved in `supersedes` or
 * `conflicts_with` verdicts. It's a flag on the row (not a separate table)
 * because the most common read is "is this criterion current?" — a single
 * column answer beats a JOIN against observation_relations.
 *
 * Non-destructive: ADD COLUMN with a default, plus an index for the
 * "list non-deprecated criteria" query. No FKs, no triggers. The column
 * defaults to 0 so every pre-v5 row reads as "not deprecated".
 */
export const DEPRECATED_COLUMN_SCHEMA_SQL = `
ALTER TABLE observations ADD COLUMN deprecated INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Schema for per-agent token telemetry — added in schema v6.
 *
 * Row grain is `(session_id, agent_id, model)`. The four `usage` components
 * stay four columns and are never collapsed; the six output classes are
 * stored next to the `thinking_method` label that says whether `out_thinking`
 * was metered by the provider or attributed by byte share. No price and no
 * dollar amount is stored — money is computed at report time.
 *
 * Entirely CREATE ... IF NOT EXISTS: additive, and a no-op on a DB that
 * already carries the table.
 */
export const AGENT_TOKEN_USAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_token_usage (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  agent TEXT NOT NULL,
  task_type TEXT NOT NULL,
  description TEXT,
  tool_use_id TEXT,
  spawn_depth INTEGER,
  duration_ms INTEGER,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  out_thinking INTEGER NOT NULL DEFAULT 0,
  out_prose INTEGER NOT NULL DEFAULT 0,
  out_tool_call INTEGER NOT NULL DEFAULT 0,
  out_code INTEGER NOT NULL DEFAULT 0,
  out_test INTEGER NOT NULL DEFAULT 0,
  out_doc INTEGER NOT NULL DEFAULT 0,
  thinking_method TEXT NOT NULL,
  tool_calls INTEGER,
  partial INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id, model)
);
CREATE INDEX IF NOT EXISTS idx_atu_agent ON agent_token_usage(agent);
CREATE INDEX IF NOT EXISTS idx_atu_task_type ON agent_token_usage(task_type);
CREATE INDEX IF NOT EXISTS idx_atu_model ON agent_token_usage(model);
CREATE INDEX IF NOT EXISTS idx_atu_ingested ON agent_token_usage(ingested_at);
CREATE INDEX IF NOT EXISTS idx_atu_tool_use ON agent_token_usage(tool_use_id);
`;

/**
 * Schema for the histórico-de-telemetría snapshot tables — added in schema v8.
 *
 * Four tables, all CREATE ... IF NOT EXISTS: additive, no ALTER on any
 * existing table (`agent_token_usage` is untouched). Shapes and the
 * nullable-without-DEFAULT columns (`tool_calls`, `tool_calls_gap`, `author`)
 * follow the telemetry history design notes Decision 3.
 */
export const TELEMETRY_SNAPSHOT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS telemetry_snapshot (
  id TEXT PRIMARY KEY,
  taken_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  session_id TEXT,
  schema_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_session ON telemetry_snapshot(session_id);
CREATE INDEX IF NOT EXISTS idx_snap_reason ON telemetry_snapshot(reason);

CREATE TABLE IF NOT EXISTS telemetry_snapshot_total (
  snapshot_id TEXT NOT NULL REFERENCES telemetry_snapshot(id),
  axis TEXT NOT NULL,
  group_key TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  turns INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  tool_calls INTEGER,
  tool_calls_gap TEXT,
  PRIMARY KEY (snapshot_id, axis, group_key)
);

CREATE TABLE IF NOT EXISTS telemetry_snapshot_output_class (
  snapshot_id TEXT NOT NULL REFERENCES telemetry_snapshot(id),
  axis TEXT NOT NULL,
  group_key TEXT NOT NULL,
  class TEXT NOT NULL,
  class_total INTEGER NOT NULL,
  measured_share REAL NOT NULL,
  PRIMARY KEY (snapshot_id, axis, group_key, class)
);

CREATE TABLE IF NOT EXISTS telemetry_snapshot_note (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES telemetry_snapshot(id),
  created_at TEXT NOT NULL,
  author TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_note_snapshot ON telemetry_snapshot_note(snapshot_id);
`;

// busy_timeout matches better-sqlite3's own implicit default (5000ms), made
// explicit and greppable so it lives next to the other connection pragmas and
// survives any future change to the library default. Tune here if SQLITE_BUSY
// ever surfaces under real multi-agent contention — one place, one constant.
const BUSY_TIMEOUT_MS = 5000;

/**
 * A schema migration: a dense, 1-based version, a human label used only in
 * errors/logs, and a synchronous `up`. `up` MUST be synchronous — better-sqlite3
 * is sync and `db.transaction()` commits early if handed an async function.
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/**
 * Ordered migration registry. NEVER renumber or reorder a released entry —
 * only append. Versions are dense and strictly increasing from 1, so the
 * array length equals the latest version.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline-v0.1-shape",
    // The baseline IS the current SCHEMA_SQL. It is entirely CREATE ... IF NOT
    // EXISTS, so it creates the schema on a fresh DB and is a true no-op on an
    // existing v0.1 DB — no drops, no rewrites, no data loss. Both converge at
    // user_version = 1.
    up: (db) => db.exec(SCHEMA_SQL),
  },
  {
    version: 2,
    name: "add-bitacora",
    // Adds the day-level bitácora table. All CREATE ... IF NOT EXISTS, so it
    // creates the table on a v1 DB (observations only) and is a no-op if the
    // table already exists — it never touches observations/sessions data.
    up: (db) => db.exec(BITACORA_SCHEMA_SQL),
  },
  {
    version: 3,
    name: "add-dedup-fields",
    // Adds deterministic dedup: two columns + a covering index, plus a
    // one-time backfill of content_hash for every existing row. ADD COLUMN is
    // a cheap metadata-only op in SQLite; the backfill is the only O(rows)
    // cost (tiny for a personal libreta). NON-DESTRUCTIVE: it never deletes
    // or merges existing rows — pre-migration duplicates are hashed as-is and
    // preserved (collapsing them would be data loss on migrate). Dedup applies
    // to FUTURE saves. `revision_count NOT NULL DEFAULT 1` means every legacy
    // row reads as "seen once". Runs inside the migration transaction.
    up: (db) => {
      db.exec(`
        ALTER TABLE observations ADD COLUMN content_hash TEXT;
        ALTER TABLE observations ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 1;
      `);
      const rows = db
        .prepare<
          [],
          { id: string; type: string; title: string; what: string; why: string; where_: string; learned: string }
        >("SELECT id, type, title, what, why, where_, learned FROM observations")
        .all();
      const upd = db.prepare("UPDATE observations SET content_hash = ? WHERE id = ?");
      for (const r of rows) {
        const hash = contentHash({
          type: r.type,
          title: r.title,
          what: r.what,
          why: r.why,
          where: r.where_,
          learned: r.learned,
        });
        upd.run(hash, r.id);
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_obs_dedup ON observations(project, topic_key, content_hash);",
      );
    },
  },
  {
    version: 4,
    name: "add-observation-relations",
    // mem_judge (Part B): verdicts / relations between two observations.
    // Append-only, no ALTER, no UPDATE on existing rows. The table is keyed
    // by the (obs_a_id, obs_b_id) pair so re-judging overwrites the prior
    // verdict (handled by the runner via INSERT ... ON CONFLICT in Lote 2 —
    // schema-only here). No FKs on purpose: the verdict history is
    // advisory/metadata and must survive any hard-delete of an observation.
    up: (db) => db.exec(OBSERVATION_RELATIONS_SCHEMA_SQL),
  },
  {
    version: 5,
    name: "add-observation-deprecated",
    // mem_judge Lote 3: the soft-deprecate flag set by `memory judge --apply`.
    // Single ADD COLUMN (metadata-only op in SQLite) + covering index. Every
    // pre-v5 row reads as `deprecated = 0` via the DEFAULT, so the migration
    // is purely additive — no UPDATE on existing data, no data loss.
    up: (db) => {
      db.exec(DEPRECATED_COLUMN_SCHEMA_SQL);
      db.exec("CREATE INDEX IF NOT EXISTS idx_obs_deprecated ON observations(deprecated);");
    },
  },
  {
    version: 6,
    name: "add-agent-token-usage",
    // Per-agent token telemetry. All CREATE ... IF NOT EXISTS, no ALTER on any
    // existing table: observations, sessions, bitacora and
    // observation_relations are untouched by construction.
    up: (db) => db.exec(AGENT_TOKEN_USAGE_SCHEMA_SQL),
  },
  {
    version: 7,
    name: "add-tool-calls",
    up: (db) => {
      const present = db
        .prepare<[], { c: number }>(
          "SELECT COUNT(*) AS c FROM pragma_table_info('agent_token_usage') WHERE name = 'tool_calls'",
        )
        .get();
      if ((present?.c ?? 0) === 0) {
        db.exec("ALTER TABLE agent_token_usage ADD COLUMN tool_calls INTEGER;");
      }
    },
  },
  {
    version: 8,
    name: "add-telemetry-snapshot-tables",
    up: (db) => db.exec(TELEMETRY_SNAPSHOT_SCHEMA_SQL),
  },
];

/**
 * Highest registered schema version. Dense versions ⇒ length == max version.
 *
 * Production reads the same value as `MIGRATIONS.length` inside this module;
 * the export exists so a test can assert the registry and the stamp agree.
 *
 * @callerless-exempt test-visibility
 */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Forward-only, transactional migration runner. Reads the DB's current
 * `user_version`, refuses a DB newer than we support, then applies every
 * pending migration in ascending order. Each migration's DDL and its version
 * stamp run inside a single `db.transaction()` so they commit or roll back
 * atomically — a crash can never leave a migrated shape reporting the old
 * version.
 *
 * `migrations` defaults to the module registry but is a parameter so tests can
 * inject a synthetic list.
 */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  const latest = migrations.length; // dense ⇒ length == max version
  const current = db.pragma("user_version", { simple: true }) as number;

  if (current > latest) {
    // DB written by a NEWER build. Forward-only means we cannot safely
    // downgrade — fail loud rather than run old code against a new shape.
    throw new Error(
      `libreta DB schema v${current} is newer than supported v${latest}; upgrade libreta`,
    );
  }

  for (const m of migrations) {
    if (m.version <= current) continue; // already applied
    const step = db.transaction(() => {
      m.up(db);
      // Stamped INSIDE the tx: user_version writes to the header page and
      // participates in the transaction, so shape change + version stamp are
      // atomic. No manual ROLLBACK — better-sqlite3 rolls the tx back on throw.
      db.pragma(`user_version = ${m.version}`);
    });
    try {
      step();
    } catch (err) {
      throw new Error(
        `migration v${m.version} (${m.name}) failed: ${(err as Error).message}`,
      );
    }
  }
}

export class LibretaDB {
  private readonly db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.dbPath = dbPath;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // Tighten file permissions on POSIX (SEC-6/SEC-12): the DB holds
    // plaintext observation fields and must not be world-readable. We do
    // this AFTER `new Database(...)` because better-sqlite3 may create
    // ancillary files. In WAL mode those are `<db>-wal` (write-ahead log,
    // also plaintext) and `<db>-shm` (shared-memory index) — and they are
    // created lazily on the first write transaction, NOT at open time, so
    // the constructor-only chmod here cannot cover them yet.
    //
    // What we do here:
    //   1. chmod the main DB file (created by `new Database(...)`).
    //   2. attempt the sidecars too in case the file existed prior (e.g.
    //      a partial earlier run left them behind on disk).
    // The post-write chmod that closes SEC-12 lives in `applyPosix0600()`
    // and is invoked from `save()` / `init()` AFTER a write has had a
    // chance to materialize the sidecars.
    //
    // No-op on Windows where POSIX mode bits do not exist (SEC-7).
    if (!isWindows()) {
      this.applyPosix0600(dbPath);
    }
  }

  /**
   * chmod 0600 on POSIX for the main DB file and any pre-existing WAL/SHM
   * sidecars. Silent on EPERM (read-only bind mount): the DB is still
   * functional, just without the tightening. Re-throws on hard failures
   * (EACCES on a writable dir, etc.) so corruption surfaces loudly.
   *
   * Public so a caller can re-run it after operations that may have
   * re-created the sidecars (e.g. a checkpoint that deletes the -wal).
   */
  applyPosix0600(dbPath: string): void {
    const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    for (const p of candidates) {
      try {
        chmodSync(p, 0o600);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ENOENT is fine: the sidecar simply does not exist yet (it is
        // created lazily on first write). EPERM is a soft failure (read-only
        // mount); anything else is a hard failure we must surface.
        if (code !== "ENOENT" && code !== "EPERM") throw err;
      }
    }
  }

  /**
   * Bring the DB schema up to `LATEST_SCHEMA_VERSION` via the migration runner.
   * On a fresh or v0.1 DB this creates/leaves the baseline shape and stamps
   * `user_version = 1`; on an already-current DB it is a no-op. Must be called
   * before any read/write.
   */
  init(): void {
    migrate(this.db);
  }

  // ─────────────────────────────────────────────────────────
  //  Observations
  // ─────────────────────────────────────────────────────────

  /**
   * Save an observation with deterministic dedup (change libreta-dedup).
   *
   * The dedup bucket is `(project, topic_key, content_hash)` with a NULL-safe
   * match on `topic_key` (a null topic matches only other null topics). If a
   * row with the same content already exists in the bucket, this does NOT
   * insert a new row: it increments that row's `revision_count`, bumps its
   * `updated_at` (leaving `created_at`/`id` unchanged) and returns it. On a
   * bump the FTS content is unchanged (the AFTER UPDATE trigger re-syncs with
   * identical text, so search still returns exactly one hit). Otherwise it
   * inserts a fresh ULID row with `revision_count = 1`. The lookup + write are
   * one atomic transaction. ULID generated server-side; `created_at` and
   * `updated_at` set to the same instant (ISO 8601, UTC) on insert.
   */
  save(
    input: Omit<Observation, "id" | "created_at" | "updated_at" | "revision_count" | "content_hash">,
  ): Observation {
    const now = new Date().toISOString();
    const hash = contentHash({
      type: input.type,
      title: input.title,
      what: input.what,
      why: input.why,
      where: input.where,
      learned: input.learned,
    });
    const topicKey = input.topic_key ?? null;

    const tx = this.db.transaction((): Observation => {
      const existing = this.db
        .prepare<{ project: string; topic_key: string | null; hash: string }, ObservationRow>(
          `SELECT * FROM observations
           WHERE project = @project AND topic_key IS @topic_key AND content_hash = @hash
           LIMIT 1`,
        )
        .get({ project: input.project, topic_key: topicKey, hash });

      if (existing) {
        // Bump: no new row, no FTS churn beyond the identical-content re-sync.
        this.db
          .prepare("UPDATE observations SET revision_count = revision_count + 1, updated_at = @now WHERE id = @id")
          .run({ now, id: existing.id });
        return {
          ...rowToObservation(existing),
          revision_count: existing.revision_count + 1,
          updated_at: now,
        };
      }

      const obs: Observation = {
        id: ulid(),
        created_at: now,
        updated_at: now,
        content_hash: hash,
        revision_count: 1,
        ...input,
      };
      this.db
        .prepare(
          `INSERT INTO observations
           (id, project, session_id, topic_key, title, type, what, why, where_, learned, content_hash, revision_count, created_at, updated_at)
           VALUES (@id, @project, @session_id, @topic_key, @title, @type, @what, @why, @where_, @learned, @content_hash, @revision_count, @created_at, @updated_at)`,
        )
        .run({
          id: obs.id,
          project: obs.project,
          session_id: obs.session_id ?? null,
          topic_key: obs.topic_key ?? null,
          title: obs.title,
          type: obs.type,
          what: obs.what,
          why: obs.why,
          where_: obs.where,
          learned: obs.learned,
          content_hash: hash,
          revision_count: 1,
          created_at: obs.created_at,
          updated_at: obs.updated_at,
        });
      return obs;
    });

    const result = tx();
    // SEC-12: a write in WAL mode materializes `<db>-wal` (plaintext) and
    // `<db>-shm`. Re-apply 0600 to whatever exists so the sidecars stay
    // owner-only. Idempotent and cheap (3 chmod syscalls). Runs on every
    // save (insert OR bump) so newly-created sidecars cannot outlive a
    // tightened older one.
    this.applyPosix0600(this.dbPath);
    return result;
  }

  /** Update an observation by id. Returns the updated observation, or null if not found. */
  update(id: string, patch: Partial<Omit<Observation, "id" | "created_at">>): Observation | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const merged: Observation = {
      ...existing,
      ...patch,
      id: existing.id,
      created_at: existing.created_at,
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE observations SET
          project = @project, session_id = @session_id, topic_key = @topic_key,
          title = @title, type = @type, what = @what, why = @why, where_ = @where_,
          learned = @learned, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id: merged.id,
        project: merged.project,
        session_id: merged.session_id ?? null,
        topic_key: merged.topic_key ?? null,
        title: merged.title,
        type: merged.type,
        what: merged.what,
        why: merged.why,
        where_: merged.where,
        learned: merged.learned,
        updated_at: merged.updated_at,
      });
    return merged;
  }

  /** Delete an observation by id. Returns true if a row was removed. */
  delete(id: string): boolean {
    const info = this.db.prepare("DELETE FROM observations WHERE id = ?").run(id);
    return info.changes > 0;
  }

  /** Get an observation by id. Returns null if not found. */
  getById(id: string): Observation | null {
    const row = this.db
      .prepare<[string], ObservationRow>("SELECT * FROM observations WHERE id = ?")
      .get(id);
    return row ? rowToObservation(row) : null;
  }

  /**
   * Full-text search using FTS5. Returns bm25-ranked results. Returns
   * empty array if `query` is empty/whitespace.
   */
  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    if (!query || !query.trim()) return [];
    const limit = opts.limit ?? 20;
    // Escape FTS5 special chars by wrapping each token in quotes — keeps
    // the query simple and avoids syntax errors on user input.
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .map((tok) => `"${tok.replace(/"/g, '""')}"`)
      .join(" ");

    const where: string[] = ["observations_fts MATCH ?"];
    const params: (string | number)[] = [ftsQuery];
    if (opts.project) {
      where.push("observations.project = ?");
      params.push(opts.project);
    }
    if (opts.type) {
      where.push("observations.type = ?");
      params.push(opts.type);
    }

    const sql = `
      SELECT observations.*, bm25(observations_fts) AS score,
             snippet(observations_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet
      FROM observations_fts
      JOIN observations ON observations.rowid = observations_fts.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY score
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db
      .prepare<unknown[], ObservationRow & { score: number; snippet: string }>(sql)
      .all(...params);
    return rows.map((row) => ({
      observation: rowToObservation(row),
      score: row.score,
      snippet: row.snippet,
    }));
  }

  /** List observations newest-first with optional filters. */
  list(opts: ListOptions = {}): Observation[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.project) {
      where.push("project = ?");
      params.push(opts.project);
    }
    if (opts.session_id) {
      where.push("session_id = ?");
      params.push(opts.session_id);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const sql = `
      SELECT * FROM observations
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    const rows = this.db.prepare<unknown[], ObservationRow>(sql).all(...params);
    return rows.map(rowToObservation);
  }

  /**
   * List a persona's personal validation criteria (change persona-criteria).
   *
   * A criterion is a normal `preference` observation stored under
   * `topic_key = "criteria:<persona>"` — no new type, no new write path. This
   * read returns ONLY those rows for the given persona, ordered by
   * `revision_count` DESC (most-confirmed first), then `created_at` ASC as a
   * stable tiebreak (oldest-established first among equal confirmation counts).
   * Reuses the existing `idx_obs_topic` index. When `project` is given the
   * result is scoped to it; otherwise criteria across all projects are returned.
   * No caching — a row saved after a prior read is visible immediately.
   */
  listCriteria(persona: string, project?: string): Observation[] {
    const topicKey = `criteria:${persona}`;
    const where: string[] = ["topic_key = ?", "type = 'preference'"];
    const params: (string | number)[] = [topicKey];
    if (project) {
      where.push("project = ?");
      params.push(project);
    }
    const sql = `
      SELECT * FROM observations
      WHERE ${where.join(" AND ")}
      ORDER BY revision_count DESC, created_at ASC
    `;
    const rows = this.db.prepare<unknown[], ObservationRow>(sql).all(...params);
    return rows.map(rowToObservation);
  }

  /**
   * Deterministic candidate finder for mem_judge (change `mem-judge`, Part B,
   * Layer 1). Given an observation id, returns near-duplicate / potentially-
   * conflicting observations in the SAME persona bucket using the existing
   * FTS5 index. Pure SQL — no model, no LLM, fully unit-testable.
   *
   * Scope (per spec "a deterministic candidate finder"):
   *   - same `project` AND same `topic_key` as the source observation
   *     (this is what makes the finder bucket-safe: criteria:coder never
   *     sees criteria:revisor rows)
   *   - excludes the source row itself
   *   - **excludes deprecated rows** (`observations.deprecated = 0`) — a
   *     soft-deprecated criterion is "out of the picture" from the judge's
   *     perspective; surface stale retired criteria to live ones and the
   *     user gets confusing cross-pair suggestions. The flag is set by
   *     `memory judge --apply` (see `markDeprecated`); retracting it is a
   *     v2 command (`memory un-deprecate`), not in scope here. Until
   *     retracted, the row stays out of the candidate set entirely.
   *   - applies a BM25 relevance floor (default `0.0`; rationale on the
   *     `FindCandidatesOptions.floor` field — bm25 magnitudes are
   *     corpus-dependent so a permissive default is the safer v1 choice)
   *   - cap result count (default 3, via `opts.limit`)
   *
   * Ranking: ascending BM25 — smaller (more negative) = more relevant.
   *
   * Returns `[]` if the source row is missing or has no same-bucket,
   * non-deprecated neighbours (no exception thrown).
   */
  findCandidates(obsId: string, opts: FindCandidatesOptions = {}): CandidateMatch[] {
    const source = this.getById(obsId);
    if (!source) return [];

    const floor = opts.floor ?? 0.0;
    const limit = opts.limit ?? 3;
    // If the source has no topic_key, callers almost always meant a bucket
    // we can scope to — but the existing topic_key index would never match a
    // `criteria:<persona>` here. We still respect the source's own
    // (project, topic_key) pair, which is `NULL` for topic_key-less rows.
    // Other `NULL`-topic rows in the same project DO come back — that is the
    // same NULL-safe semantics used by save() / listCriteria().
    //
    // Note: the `deprecated = 0` filter applies to CANDIDATES, not to the
    // source row itself. A deprecated source can still be passed in (e.g. by
    // the orchestrator iterating all criteria); its non-deprecated
    // counterparts will surface as candidates. This is the v1 model:
    // "deprecated = out of the picture as a target, not as a participant".
    // Pairs where BOTH sides are deprecated produce no candidate from either
    // side, so they're naturally never re-judged.

    // Tokenize the title for FTS5. Strip non-letter / non-number chars
    // before quoting so we tokenize the same way the FTS5 unicode61 tokenizer
    // does at index time (e.g. `"first,"` would never match the indexed
    // `first` because the comma survives the literal-phrase match). Empty
    // tokens (all-punctuation words) are dropped.
    //
    // Join tokens with `OR` (not space) so the candidate finder matches rows
    // that share ANY title token, not rows that share ALL of them. We want
    // "potential near-duplicates" surfaced; bm25 ranking + the floor below
    // do the relevance filtering. Each token is still wrapped in double
    // quotes (FTS5 phrase match), so any token that happens to collide with
    // an FTS5 operator word (OR / AND / NOT / NEAR) is treated as a literal
    // phrase rather than parsed as syntax.
    const title = source.title.trim();
    if (!title) return [];

    const ftsQuery = title
      .split(/\s+/)
      .map((tok) => tok.replace(/[^\p{L}\p{N}]+/gu, ""))
      .filter((tok) => tok.length > 0)
      .map((tok) => `"${tok.replace(/"/g, '""')}"`)
      .join(" OR ");

    const sql = `
      SELECT observations.*, bm25(observations_fts) AS score
      FROM observations_fts
      JOIN observations ON observations.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND observations.project = ?
        AND observations.topic_key IS ?
        AND observations.id != ?
        AND observations.deprecated = 0
        AND bm25(observations_fts) <= ?
      ORDER BY score
      LIMIT ?
    `;
    // SQLite `IS` with a parameter does a NULL-safe equality match: NULL IS
    // NULL → true, NULL IS ? → matches when the bound value is NULL. That is
    // exactly the bucket semantics we want (a null-topic source only sees
    // other null-topic rows in the same project).
    const rows = this.db
      .prepare<
        [string, string, string | null, string, number, number],
        ObservationRow & { score: number }
      >(sql)
      .all(
        ftsQuery,
        source.project,
        source.topic_key ?? null,
        source.id,
        floor,
        limit,
      );

    return rows.map((row) => ({
      observation: rowToObservation(row),
      score: row.score,
    }));
  }

  // ─────────────────────────────────────────────────────────
  //  mem_judge verdicts (Layer 2 storage — change `mem-judge`, Part B)
  // ─────────────────────────────────────────────────────────

  /**
   * Persist or overwrite the verdict for a (a_id, b_id) pair.
   *
   * The pair's PK guarantees idempotency: re-judging the same pair overwrites
   * the relation + confidence + reasoning + updated_at; created_at is
   * preserved (it's the original judgment time, not the revision time).
   * Both timestamps are stamped inside the same `INSERT ... ON CONFLICT` so
   * the audit trail stays coherent under concurrent re-runs.
   */
  saveVerdict(aId: string, bId: string, verdict: Verdict): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO observation_relations
           (obs_a_id, obs_b_id, relation, confidence, reasoning, created_at, updated_at)
         VALUES (@a, @b, @rel, @conf, @why, @now, @now)
         ON CONFLICT(obs_a_id, obs_b_id) DO UPDATE SET
           relation   = excluded.relation,
           confidence = excluded.confidence,
           reasoning  = excluded.reasoning,
           updated_at = excluded.updated_at`,
      )
      .run({
        a: aId,
        b: bId,
        rel: verdict.relation,
        conf: verdict.confidence,
        why: verdict.reasoning,
        now,
      });
  }

  /** Read the stored verdict for a single pair, or null if none. */
  getVerdict(aId: string, bId: string): StoredVerdict | null {
    const row = this.db
      .prepare<
        [string, string],
        {
          obs_a_id: string;
          obs_b_id: string;
          relation: string;
          confidence: number;
          reasoning: string;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT obs_a_id, obs_b_id, relation, confidence, reasoning, created_at, updated_at
         FROM observation_relations
         WHERE obs_a_id = ? AND obs_b_id = ?`,
      )
      .get(aId, bId);
    if (!row) return null;
    return {
      obs_a_id: row.obs_a_id,
      obs_b_id: row.obs_b_id,
      relation: row.relation as Relation,
      confidence: row.confidence,
      reasoning: row.reasoning,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * List every verdict that touches any of the given observation ids
   * (either side of the pair). Used by the judge's "show what I judged"
   * output.
   */
  getVerdictsForCriteria(ids: readonly string[]): StoredVerdict[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    // Build the parameter tuple explicitly so the type checker accepts a
    // double-spread (same array used twice in the IN list). better-sqlite3's
    // .all() takes a rest parameter — `[...ids, ...ids]` satisfies that
    // and is strictly typed.
    const params: string[] = [...ids, ...ids];
    const rows = this.db
      .prepare<string[], {
        obs_a_id: string;
        obs_b_id: string;
        relation: string;
        confidence: number;
        reasoning: string;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT obs_a_id, obs_b_id, relation, confidence, reasoning, created_at, updated_at
         FROM observation_relations
         WHERE obs_a_id IN (${placeholders}) OR obs_b_id IN (${placeholders})
         ORDER BY updated_at DESC`,
      )
      .all(...params);
    return rows.map((r) => ({
      obs_a_id: r.obs_a_id,
      obs_b_id: r.obs_b_id,
      relation: r.relation as Relation,
      confidence: r.confidence,
      reasoning: r.reasoning,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Soft-deprecate the given observations. Sets `deprecated = 1` on each
   * row. Idempotent — calling twice is a no-op. This is the destructive-
   * but-reversible step in mem_judge: the row stays in storage, the user
   * (or a future Lote) can clear the flag manually.
   *
   * Re-running `memory judge --apply` with a different verdict RE-APPLIES
   * the rules on the new verdict — deprecation is sticky for rows that were
   * deprecated by an earlier run even if the new verdict doesn't say so.
   * Documented in `flow/memory.md`; "un-deprecate" is a v2 concern.
   */
  markDeprecated(obsIds: readonly string[]): void {
    if (obsIds.length === 0) return;
    const placeholders = obsIds.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE observations SET deprecated = 1 WHERE id IN (${placeholders})`)
      .run(...obsIds);
  }

  /** True iff the observation has been soft-deprecated. */
  isDeprecated(obsId: string): boolean {
    const row = this.db
      .prepare<[string], { deprecated: number }>(
        "SELECT deprecated FROM observations WHERE id = ?",
      )
      .get(obsId);
    return row?.deprecated === 1;
  }

  // ─────────────────────────────────────────────────────────
  //  Bitácora (day-level executive index — distinct from observations)
  // ─────────────────────────────────────────────────────────

  /**
   * Record a bitácora day entry. ULID generated server-side; `created_at` set
   * now (ISO 8601, UTC). `linked_ids` is stored as a JSON text array.
   */
  addBitacora(
    input: Omit<BitacoraEntry, "id" | "created_at"> & { linked_ids?: string[] },
  ): BitacoraEntry {
    const entry: BitacoraEntry = {
      id: ulid(),
      created_at: new Date().toISOString(),
      project: input.project,
      date: input.date,
      headline: input.headline,
      summary: input.summary,
      linked_ids: input.linked_ids ?? [],
    };
    this.db
      .prepare(
        `INSERT INTO bitacora (id, project, date, headline, summary, linked_ids, created_at)
         VALUES (@id, @project, @date, @headline, @summary, @linked_ids, @created_at)`,
      )
      .run({
        id: entry.id,
        project: entry.project,
        date: entry.date,
        headline: entry.headline,
        summary: entry.summary,
        linked_ids: JSON.stringify(entry.linked_ids),
        created_at: entry.created_at,
      });
    if (!isWindows()) this.applyPosix0600(this.dbPath);
    return entry;
  }

  /** All bitácora entries for a project on a given day, newest-recorded first. */
  bitacoraDay(project: string, date: string): BitacoraEntry[] {
    const rows = this.db
      .prepare<[string, string], BitacoraRow>(
        `SELECT * FROM bitacora WHERE project = ? AND date = ? ORDER BY created_at DESC`,
      )
      .all(project, date);
    return rows.map(rowToBitacora);
  }

  /**
   * Bitácora entries for a project within [from, to] inclusive (dates compared
   * lexically — ISO dates sort correctly), ordered oldest day first.
   */
  bitacoraRange(
    project: string,
    from: string,
    to: string,
    opts: BitacoraRangeOptions = {},
  ): BitacoraEntry[] {
    const limit = opts.limit ?? 500;
    const rows = this.db
      .prepare<[string, string, string, number], BitacoraRow>(
        `SELECT * FROM bitacora
         WHERE project = ? AND date >= ? AND date <= ?
         ORDER BY date ASC, created_at ASC
         LIMIT ?`,
      )
      .all(project, from, to, limit);
    return rows.map(rowToBitacora);
  }

  // ─────────────────────────────────────────────────────────
  //  Agent token telemetry (read-only from the lib_* surface)
  // ─────────────────────────────────────────────────────────

  /**
   * Replace every telemetry row of one session with `rows`, atomically.
   *
   * Replace-not-append is what makes ingest idempotent: a re-run of the same
   * session converges on the same series instead of doubling it.
   */
  replaceSessionTelemetry(
    sessionId: string,
    rows: readonly TelemetryRow[],
  ): { snapshotGap: Gap | null } {
    const del = this.db.prepare("DELETE FROM agent_token_usage WHERE session_id = ?");
    const ins = this.db.prepare(
      `INSERT INTO agent_token_usage (
         session_id, agent_id, model, agent, task_type, description, tool_use_id, duration_ms,
         spawn_depth, turns, input_tokens, output_tokens, cache_creation_tokens,
         cache_read_tokens, out_thinking, out_prose, out_tool_call, out_code,
         out_test, out_doc, thinking_method, tool_calls, partial, ingested_at
       ) VALUES (
         @session_id, @agent_id, @model, @agent, @task_type, @description, @tool_use_id, @duration_ms,
         @spawn_depth, @turns, @input_tokens, @output_tokens, @cache_creation_tokens,
         @cache_read_tokens, @out_thinking, @out_prose, @out_tool_call, @out_code,
         @out_test, @out_doc, @thinking_method, @tool_calls, @partial, @ingested_at
       )`,
    );
    let snapshotGap: Gap | null = null;
    const tx = this.db.transaction((batch: readonly TelemetryRow[]) => {
      try {
        this.captureSnapshot(sessionId);
      } catch (err) {
        snapshotGap = {
          kind: "gap",
          agentId: null,
          path: sessionId,
          reason: "snapshot-capture-failed",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      del.run(sessionId);
      for (const r of batch) ins.run({ ...r });
    });
    tx(rows);
    if (!isWindows()) this.applyPosix0600(this.dbPath);
    return { snapshotGap };
  }

  private captureSnapshot(sessionId: string): void {
    const rows = this.db
      .prepare<[string], TelemetryRow>("SELECT * FROM agent_token_usage WHERE session_id = ?")
      .all(sessionId);
    if (rows.length === 0) return;

    const axisGroups = snapshotAxisGroups(rows);
    const latest = this.latestPreReplaceSnapshot(sessionId);
    if (latest) {
      const previous = this.canonicalizeStoredSnapshot(latest.id);
      const next = canonicalizeAggregate(axisGroups);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
    }

    this.db.transaction(() => this.writeSnapshot(sessionId, axisGroups))();
  }

  private writeSnapshot(
    sessionId: string,
    axisGroups: ReturnType<typeof snapshotAxisGroups>,
  ): void {
    const snapshotId = ulid();
    this.db
      .prepare(
        `INSERT INTO telemetry_snapshot (id, taken_at, reason, session_id, schema_version)
         VALUES (@id, @taken_at, @reason, @session_id, @schema_version)`,
      )
      .run({
        id: snapshotId,
        taken_at: new Date().toISOString(),
        reason: "pre-replace",
        session_id: sessionId,
        schema_version: LATEST_SCHEMA_VERSION,
      });

    const insTotal = this.db.prepare(
      `INSERT INTO telemetry_snapshot_total (
         snapshot_id, axis, group_key, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, turns, sessions,
         tool_calls, tool_calls_gap
       ) VALUES (
         @snapshot_id, @axis, @group_key, @input_tokens, @output_tokens,
         @cache_creation_tokens, @cache_read_tokens, @turns, @sessions,
         @tool_calls, @tool_calls_gap
       )`,
    );
    const insClass = this.db.prepare(
      `INSERT INTO telemetry_snapshot_output_class (
         snapshot_id, axis, group_key, class, class_total, measured_share
       ) VALUES (
         @snapshot_id, @axis, @group_key, @class, @class_total, @measured_share
       )`,
    );

    for (const { axis, groups } of axisGroups) {
      for (const g of groups) {
        insTotal.run({
          snapshot_id: snapshotId,
          axis,
          group_key: g.key,
          input_tokens: g.input_tokens,
          output_tokens: g.output_tokens,
          cache_creation_tokens: g.cache_creation_tokens,
          cache_read_tokens: g.cache_read_tokens,
          turns: g.turns,
          sessions: g.sessions,
          tool_calls: g.tool_calls,
          tool_calls_gap: g.tool_calls_gap,
        });
        for (const cls of OUTPUT_CLASSES) {
          insClass.run({
            snapshot_id: snapshotId,
            axis,
            group_key: g.key,
            class: cls,
            class_total: g.class_totals[cls],
            measured_share: g.measured_share,
          });
        }
      }
    }
  }

  /** Most recently written `pre-replace` (or any-reason) snapshot for a session, or `null`. */
  latestSnapshotForSession(sessionId: string): TelemetrySnapshotRow | null {
    return (
      this.db
        .prepare<[string], TelemetrySnapshotRow>(
          `SELECT * FROM telemetry_snapshot WHERE session_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1`,
        )
        .get(sessionId) ?? null
    );
  }

  /** One snapshot event by id, or `null` when no such snapshot was ever written. */
  snapshotById(snapshotId: string): TelemetrySnapshotRow | null {
    return (
      this.db
        .prepare<[string], TelemetrySnapshotRow>(`SELECT * FROM telemetry_snapshot WHERE id = ?`)
        .get(snapshotId) ?? null
    );
  }

  /** A snapshot's axis-group aggregates, in the shape `compareReport` reads from either side (TH-9/TH-10). */
  snapshotGroups(snapshotId: string): ComparableSnapshotGroup[] {
    return this.canonicalizeStoredSnapshot(snapshotId);
  }

  /**
   * The live series' current axis-group aggregates for a session, computed on
   * demand from `agent_token_usage` — never stored — in the same canonical
   * shape a snapshot freezes, so `compareReport` can read either side without
   * knowing which one it got (TH-10, `design.md.addendum-1.md`).
   */
  liveComparableGroups(sessionId: string): ComparableSnapshotGroup[] {
    const rows = this.db
      .prepare<[string], TelemetryRow>("SELECT * FROM agent_token_usage WHERE session_id = ?")
      .all(sessionId);
    return canonicalizeAggregate(snapshotAxisGroups(rows));
  }

  /** Most recently written `pre-replace` snapshot for a session — the one TH-2b's dedup compares against. */
  private latestPreReplaceSnapshot(sessionId: string): TelemetrySnapshotRow | null {
    return (
      this.db
        .prepare<[string], TelemetrySnapshotRow>(
          `SELECT * FROM telemetry_snapshot
           WHERE session_id = ? AND reason = 'pre-replace'
           ORDER BY taken_at DESC, id DESC LIMIT 1`,
        )
        .get(sessionId) ?? null
    );
  }

  /** Rebuild a written snapshot's aggregate in the same canonical shape `captureSnapshot` compares against. */
  private canonicalizeStoredSnapshot(snapshotId: string): CanonicalSnapshotGroup[] {
    const totals = this.telemetrySnapshotTotals(snapshotId);
    const classRows = this.telemetrySnapshotOutputClasses(snapshotId);
    const classesByGroup = new Map<string, Record<OutputClass, number>>();
    for (const c of classRows) {
      const groupKey = `${c.axis} ${c.group_key}`;
      const existing = classesByGroup.get(groupKey);
      if (existing) existing[c.class] = c.class_total;
      else
        classesByGroup.set(groupKey, {
          thinking: 0,
          prose: 0,
          tool_call: 0,
          code: 0,
          test: 0,
          doc: 0,
          [c.class]: c.class_total,
        } as Record<OutputClass, number>);
    }
    const shareByGroup = new Map<string, number>();
    for (const c of classRows) shareByGroup.set(`${c.axis} ${c.group_key}`, c.measured_share);

    return totals
      .map((t): CanonicalSnapshotGroup => {
        const groupKey = `${t.axis} ${t.group_key}`;
        return {
          axis: t.axis,
          key: t.group_key,
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          cache_creation_tokens: t.cache_creation_tokens,
          cache_read_tokens: t.cache_read_tokens,
          turns: t.turns,
          sessions: t.sessions,
          tool_calls: t.tool_calls,
          tool_calls_gap: t.tool_calls_gap,
          classes: classesByGroup.get(groupKey) ?? {
            thinking: 0,
            prose: 0,
            tool_call: 0,
            code: 0,
            test: 0,
            doc: 0,
          },
          measured_share: shareByGroup.get(groupKey) ?? 0,
        };
      })
      .sort(compareCanonicalGroups);
  }

  /** Append a dated note to a snapshot. Never touches `telemetry_snapshot*` measurement rows (TH-7). */
  addSnapshotNote(snapshotId: string, text: string, author: string | null = null): TelemetrySnapshotNoteRow {
    const note: TelemetrySnapshotNoteRow = {
      id: monotonicUlid(),
      snapshot_id: snapshotId,
      created_at: new Date().toISOString(),
      author,
      text,
    };
    this.db
      .prepare(
        `INSERT INTO telemetry_snapshot_note (id, snapshot_id, created_at, author, text)
         VALUES (@id, @snapshot_id, @created_at, @author, @text)`,
      )
      .run({ ...note });
    if (!isWindows()) this.applyPosix0600(this.dbPath);
    return note;
  }

  /** Every note on a snapshot, oldest first. */
  snapshotNotes(snapshotId: string): TelemetrySnapshotNoteRow[] {
    return this.db
      .prepare<[string], TelemetrySnapshotNoteRow>(
        `SELECT * FROM telemetry_snapshot_note WHERE snapshot_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(snapshotId);
  }

  /** Every `(axis × group)` total row of one snapshot. */
  telemetrySnapshotTotals(snapshotId: string): TelemetrySnapshotTotalRow[] {
    return this.db
      .prepare<[string], TelemetrySnapshotTotalRow>(
        `SELECT * FROM telemetry_snapshot_total WHERE snapshot_id = ? ORDER BY axis ASC, group_key ASC`,
      )
      .all(snapshotId);
  }

  /** Every `(axis × group × class)` output-class row of one snapshot. */
  telemetrySnapshotOutputClasses(snapshotId: string): TelemetrySnapshotOutputClassRow[] {
    return this.db
      .prepare<[string], TelemetrySnapshotOutputClassRow>(
        `SELECT * FROM telemetry_snapshot_output_class WHERE snapshot_id = ? ORDER BY axis ASC, group_key ASC, class ASC`,
      )
      .all(snapshotId);
  }

  /** Telemetry rows matching the filter, newest ingest first. */
  telemetryQuery(filter: TelemetryFilter = {}): TelemetryRow[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.session_id) {
      where.push("session_id = @session_id");
      params["session_id"] = filter.session_id;
    }
    if (filter.agent) {
      where.push("agent = @agent");
      params["agent"] = filter.agent;
    }
    if (filter.exclude_agent) {
      where.push("agent <> @exclude_agent");
      params["exclude_agent"] = filter.exclude_agent;
    }
    if (filter.model) {
      where.push("model = @model");
      params["model"] = filter.model;
    }
    if (filter.task_type) {
      where.push("task_type = @task_type");
      params["task_type"] = filter.task_type;
    }
    if (filter.from) {
      where.push("ingested_at >= @from");
      params["from"] = filter.from;
    }
    if (filter.to) {
      where.push("ingested_at <= @to_end");
      params["to_end"] = /^\d{4}-\d{2}-\d{2}$/.test(filter.to)
        ? `${filter.to}T23:59:59.999Z`
        : filter.to;
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare<Record<string, string>, TelemetryRow>(
        `SELECT * FROM agent_token_usage ${clause} ORDER BY ingested_at DESC, agent_id ASC, model ASC`,
      )
      .all(params);
  }

  /** Sum the telemetry columns grouped by one allowed axis, ascending by key. */
  telemetryAggregate(axis: TelemetryAxis, filter: TelemetryFilter = {}): TelemetryGroup[] {
    if (!TELEMETRY_AXES.includes(axis)) {
      throw new Error(`unsupported telemetry axis: ${String(axis)}`);
    }
    const rows = this.telemetryQuery(filter);
    const groups = new Map<string, TelemetryGroup>();
    for (const r of rows) {
      const key = String(r[axis]);
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          rows: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          out_thinking: 0,
          out_prose: 0,
          out_tool_call: 0,
          out_code: 0,
          out_test: 0,
          out_doc: 0,
          attributed: false,
        };
        groups.set(key, g);
      }
      g.rows += 1;
      g.input_tokens += r.input_tokens;
      g.output_tokens += r.output_tokens;
      g.cache_creation_tokens += r.cache_creation_tokens;
      g.cache_read_tokens += r.cache_read_tokens;
      g.out_thinking += r.out_thinking;
      g.out_prose += r.out_prose;
      g.out_tool_call += r.out_tool_call;
      g.out_code += r.out_code;
      g.out_test += r.out_test;
      g.out_doc += r.out_doc;
      if (r.thinking_method === "attributed") g.attributed = true;
    }
    return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Volume figures (sessions, turns, tool calls, tool calls per turn, duration)
   * grouped by one allowed axis, optionally crossed with a second one.
   */
  telemetryVolume(
    axis: TelemetryAxis,
    cross?: TelemetryAxis,
    filter: TelemetryFilter = {},
  ): TelemetryVolumeGroup[] {
    if (!TELEMETRY_AXES.includes(axis)) {
      throw new Error(`unsupported telemetry axis: ${String(axis)}`);
    }
    if (cross !== undefined && !TELEMETRY_AXES.includes(cross)) {
      throw new Error(`unsupported telemetry cross axis: ${String(cross)}`);
    }

    const rows = this.telemetryQuery(filter);

    const modelsOfAgent = new Map<string, Set<string>>();
    for (const r of rows) {
      let seen = modelsOfAgent.get(r.agent_id);
      if (!seen) {
        seen = new Set<string>();
        modelsOfAgent.set(r.agent_id, seen);
      }
      seen.add(r.model);
    }

    interface Acc {
      key: string;
      key_parts: string[];
      rows: number;
      sessions: Set<string>;
      turns: number;
      toolCalls: number;
      gappedRows: number;
      durationMs: number | null;
      mixedAgents: Set<string>;
    }

    const groups = new Map<string, Acc>();
    for (const r of rows) {
      const parts = cross === undefined ? [String(r[axis])] : [String(r[axis]), String(r[cross])];
      const key = parts.join(VOLUME_KEY_SEPARATOR);
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          key_parts: parts,
          rows: 0,
          sessions: new Set<string>(),
          turns: 0,
          toolCalls: 0,
          gappedRows: 0,
          durationMs: null,
          mixedAgents: new Set<string>(),
        };
        groups.set(key, g);
      }
      g.rows += 1;
      g.sessions.add(r.session_id);
      g.turns += r.turns;
      if (r.tool_calls === null) g.gappedRows += 1;
      else g.toolCalls += r.tool_calls;
      if (r.duration_ms !== null) g.durationMs = (g.durationMs ?? 0) + r.duration_ms;
      if ((modelsOfAgent.get(r.agent_id)?.size ?? 1) > 1) g.mixedAgents.add(r.agent_id);
    }

    const gap = (reason: ReportGap["reason"], detail: string, gapped_rows: number): ReportGap => ({
      kind: "gap",
      reason,
      detail,
      gapped_rows,
    });

    return [...groups.values()]
      .map((g): TelemetryVolumeGroup => {
        const notCounted = gap(
          "tool-calls-not-counted",
          `${g.gappedRows} de ${g.rows} fila(s) del grupo se ingirieron antes del contador de tool-calls`,
          g.gappedRows,
        );
        const toolCalls: number | ReportGap = g.gappedRows > 0 ? notCounted : g.toolCalls;
        let perTurn: number | ReportGap;
        if (g.gappedRows > 0) perTurn = notCounted;
        else if (g.turns === 0) {
          perTurn = gap("zero-turns", "el grupo no tiene turnos: el denominador es cero", g.rows);
        } else perTurn = g.toolCalls / g.turns;

        const duration: number | null | ReportGap =
          g.mixedAgents.size > 0
            ? gap(
                "mixed-model-duration",
                `${g.mixedAgents.size} delegación(es) del grupo corrieron bajo más de un modelo: su duración es de la delegación, no del modelo`,
                g.mixedAgents.size,
              )
            : g.durationMs;

        return {
          key: g.key,
          key_parts: g.key_parts,
          rows: g.rows,
          sessions: g.sessions.size,
          turns: g.turns,
          tool_calls: toolCalls,
          tool_calls_per_turn: perTurn,
          duration_ms: duration,
          gapped_rows: g.gappedRows,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  // ─────────────────────────────────────────────────────────
  //  Sessions
  // ─────────────────────────────────────────────────────────

  /** Start a new session. ULID generated. `observation_count` starts at 0. */
  startSession(project: string): Session {
    const s: Session = {
      id: ulid(),
      project,
      started_at: new Date().toISOString(),
      observation_count: 0,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, project, started_at, observation_count) VALUES (?, ?, ?, 0)`,
      )
      .run(s.id, s.project, s.started_at);
    return s;
  }

  /** End a session with an optional summary. Returns updated session or null. */
  endSession(id: string, summary?: string): Session | null {
    const existing = this.getSession(id);
    if (!existing) return null;
    const endedAt = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?`)
      .run(endedAt, summary ?? null, id);
    return this.getSession(id);
  }

  /** Get a session by id. Returns null if not found. */
  getSession(id: string): Session | null {
    const row = this.db
      .prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?")
      .get(id);
    return row ? rowToSession(row) : null;
  }

  /** List sessions for a project, newest first. */
  listSessions(project?: string): Session[] {
    if (project) {
      const rows = this.db
        .prepare<[string], SessionRow>(
          "SELECT * FROM sessions WHERE project = ? ORDER BY started_at DESC",
        )
        .all(project);
      return rows.map(rowToSession);
    }
    const rows = this.db
      .prepare<[], SessionRow>("SELECT * FROM sessions ORDER BY started_at DESC")
      .all();
    return rows.map(rowToSession);
  }

  // ─────────────────────────────────────────────────────────
  //  Bulk / maintenance
  // ─────────────────────────────────────────────────────────

  /** Export everything (or a single project) as a portable JSON payload. */
  exportAll(project?: string): ExportPayload {
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      observations: project ? this.list({ project, limit: 1_000_000 }) : this.list({ limit: 1_000_000 }),
      sessions: project ? this.listSessions(project) : this.listSessions(),
    };
  }

  /**
   * Import observations and sessions. Skips rows whose id already exists
   * (idempotent). Returns counts of actually-imported rows.
   */
  importAll(data: {
    observations: Observation[];
    sessions: Session[];
  }): { observations: number; sessions: number } {
    const insertObs = this.db.prepare(
      `INSERT OR IGNORE INTO observations
       (id, project, session_id, topic_key, title, type, what, why, where_, learned, content_hash, revision_count, created_at, updated_at)
       VALUES (@id, @project, @session_id, @topic_key, @title, @type, @what, @why, @where_, @learned, @content_hash, @revision_count, @created_at, @updated_at)`,
    );
    const insertSess = this.db.prepare(
      `INSERT OR IGNORE INTO sessions (id, project, started_at, ended_at, summary, observation_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      let obs = 0;
      let sess = 0;
      for (const o of data.observations) {
        const r = insertObs.run({
          id: o.id,
          project: o.project,
          session_id: o.session_id ?? null,
          topic_key: o.topic_key ?? null,
          title: o.title,
          type: o.type,
          what: o.what,
          why: o.why,
          where_: o.where,
          learned: o.learned,
          // Recompute the content hash (export omits this internal field) with
          // the same function used by save() and the v3 migration, so identical
          // content converges on one hash regardless of entry path.
          content_hash: contentHash({
            type: o.type,
            title: o.title,
            what: o.what,
            why: o.why,
            where: o.where,
            learned: o.learned,
          }),
          // Persist the validated revision_count (older payloads default to 1
          // via import-validation) instead of falling to the column DEFAULT.
          revision_count: o.revision_count,
          created_at: o.created_at,
          updated_at: o.updated_at,
        });
        if (r.changes > 0) obs++;
      }
      for (const s of data.sessions) {
        const r = insertSess.run(
          s.id,
          s.project,
          s.started_at,
          s.ended_at ?? null,
          s.summary ?? null,
          s.observation_count,
        );
        if (r.changes > 0) sess++;
      }
      return { observations: obs, sessions: sess };
    });
    return tx();
  }

  /** High-level stats. */
  stats(): { observations: number; sessions: number; projects: number; dbSizeBytes: number } {
    const observations = (
      this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM observations").get()
    )?.c ?? 0;
    const sessions = (
      this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM sessions").get()
    )?.c ?? 0;
    const projects =
      (
        this.db
          .prepare<[], { c: number }>("SELECT count(DISTINCT project) AS c FROM observations")
          .get()
      )?.c ?? 0;
    // pragma page_count + page_size gives an approximate size.
    const pageCount = (this.db.pragma("page_count", { simple: true }) as number) ?? 0;
    const pageSize = (this.db.pragma("page_size", { simple: true }) as number) ?? 0;
    const dbSizeBytes = pageCount * pageSize;
    return { observations, sessions, projects, dbSizeBytes };
  }

  /** Best-effort health check. Returns a list of issues (empty if healthy).
   *
   * FTS5 strategy (Fase 10 fix): the previous implementation did an
   * INSERT → SELECT → DELETE roundtrip to probe FTS5. That probe was
   * racy with WAL mode + AFTER DELETE triggers and produced a false
   * positive "roundtrip failed" message even when search worked fine.
   *
   * The probe now only checks the SCHEMA: does the FTS5 virtual table
   * exist? Can it be queried at all? The actual search correctness is
   * validated every time the user calls `db.search(...)` (the real
   * test), so we don't need to duplicate it here.
   */
  doctor(): DoctorReport {
    const issues: string[] = [];

    // 0. Structural integrity. Uses quick_check (not integrity_check) so doctor
    //    stays responsive; it catches page-level corruption the schema/FTS
    //    probes below miss. Runs in its OWN try/catch — independent of the
    //    probes below — so it always executes and its result always folds into
    //    `issues`, even when a corrupt page makes a later probe throw. On a
    //    badly corrupt file quick_check itself throws SQLITE_CORRUPT rather than
    //    returning a non-"ok" row, so we treat both a throw and a non-ok row as
    //    an integrity failure.
    try {
      const rows = this.db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
      const healthy = rows.length === 1 && rows[0]?.quick_check === "ok";
      if (!healthy) {
        const detail = rows.map((r) => r.quick_check).join("; ");
        issues.push(`integrity check failed: ${detail}`);
      }
    } catch (err) {
      issues.push(`integrity check failed: ${(err as Error).message}`);
    }

    try {
      // 1. Base table queryable.
      const r = this.db.prepare("SELECT count(*) AS c FROM observations").get() as
        | { c: number }
        | undefined;
      if (!r) issues.push("cannot query observations table");

      // 2. FTS5 virtual table exists.
      const ftsExists = this.db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'",
        )
        .get();
      if (!ftsExists) issues.push("observations_fts virtual table missing");

      // 3. FTS5 can be queried. We don't need a roundtrip — we just
      //    verify the query parser accepts a trivial MATCH expression
      //    and returns a count (0 is a valid result on empty DBs).
      const ftsProbe = this.db
        .prepare<[], { c: number }>(
          "SELECT count(*) AS c FROM observations_fts WHERE observations_fts MATCH 'cameldidocprobe'",
        )
        .get();
      if (!ftsProbe) issues.push("cannot query observations_fts virtual table");

      // 4. If there's any data, verify a real search() call works. This
      //    is the end-user-facing FTS path, not a synthesized roundtrip.
      const obsCount = r?.c ?? 0;
      if (obsCount > 0) {
        try {
          this.search("cameldidocprobe", { limit: 1 });
        } catch (err) {
          issues.push(`search() probe failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      issues.push(`doctor probe threw: ${(err as Error).message}`);
    }
    return { ok: issues.length === 0, issues };
  }

  /** Close the underlying DB connection. Safe to call multiple times. */
  close(): void {
    this.db.close();
  }
}