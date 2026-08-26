/**
 * Tests for the libreta schema migration runner — `migrate()`, the
 * `MIGRATIONS` registry and `LATEST_SCHEMA_VERSION`.
 *
 * Uses a temp DB file per test. The `migrate()` unit tests drive a *raw*
 * better-sqlite3 handle with synthetic migration lists (injected via the
 * `migrations` parameter) so we can exercise ordering, rollback and the
 * newer-than-supported guard without touching the module default.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
const openHandles: Array<{ close: () => void }> = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-migrations-"));
});

afterEach(() => {
  // Close any handles the test forgot, so Windows releases the file lock
  // before the global `after` removes the dir.
  for (const h of openHandles.splice(0)) {
    try {
      h.close();
    } catch {
      // ignore
    }
  }
});

after(async () => {
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const { LibretaDB, migrate, MIGRATIONS, LATEST_SCHEMA_VERSION, SCHEMA_SQL } = await import(
  "../../src/storage/libreta-db.js"
);
const Database = (await import("better-sqlite3")).default;

type RawHandle = import("better-sqlite3").Database;

/** Reach into LibretaDB's private handle — needed to read pragmas the
 * public surface does not expose. Mirrors the cast used in the MCP tests. */
function rawOf(db: InstanceType<typeof LibretaDB>): RawHandle {
  return (db as unknown as { db: RawHandle }).db;
}

let counter = 0;
function newRaw(): RawHandle {
  const db = new Database(join(workDir, `raw-${counter++}.db`));
  openHandles.push(db);
  return db;
}

function newSpDb(name: string): InstanceType<typeof LibretaDB> {
  const db = new LibretaDB(join(workDir, `${name}.db`));
  openHandles.push(db);
  return db;
}

const seedObs = {
  project: "libreta",
  title: "seeded observation",
  type: "architecture",
  what: "content what",
  why: "content why",
  where_: "src/x.ts",
  learned: "content learned",
};

const V6_AGENT_TOKEN_USAGE_SQL = `
CREATE TABLE agent_token_usage (
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
  partial INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id, model)
);
`;

describe("storage/migrations — registry invariants", () => {
  it("MIGRATIONS versions are dense, strictly increasing, starting at 1", () => {
    assert.ok(MIGRATIONS.length >= 1, "expected at least one migration");
    MIGRATIONS.forEach((m, i) => {
      assert.equal(m.version, i + 1, `migration at index ${i} must have version ${i + 1}`);
      assert.equal(typeof m.name, "string");
      assert.equal(typeof m.up, "function");
    });
  });

  it("LATEST_SCHEMA_VERSION equals MIGRATIONS.length", () => {
    assert.equal(LATEST_SCHEMA_VERSION, MIGRATIONS.length);
  });
});

describe("storage/migrations — migrate() runner", () => {
  it("pending migrations run in ascending order and stamp user_version", () => {
    const db = newRaw();
    const order: number[] = [];
    migrate(db, [
      { version: 1, name: "one", up: () => order.push(1) },
      { version: 2, name: "two", up: () => order.push(2) },
    ]);
    assert.deepEqual(order, [1, 2], "v1 must run before v2");
    assert.equal(db.pragma("user_version", { simple: true }), 2);
  });

  it("reads user_version before deciding what to run (already-applied are skipped)", () => {
    const db = newRaw();
    db.pragma("user_version = 1");
    let ran = false;
    migrate(db, [{ version: 1, name: "one", up: () => (ran = true) }]);
    assert.equal(ran, false, "no up should run when already at latest");
    assert.equal(db.pragma("user_version", { simple: true }), 1);
  });

  it("a failing migration rolls back atomically and re-throws with context", () => {
    const db = newRaw();
    assert.throws(
      () =>
        migrate(db, [
          {
            version: 1,
            name: "ok",
            up: (h) => h.exec("CREATE TABLE probe_v1 (x)"),
          },
          {
            version: 2,
            name: "boom",
            up: (h) => {
              h.exec("CREATE TABLE probe_v2 (x)");
              throw new Error("kaboom");
            },
          },
        ]),
      (err: Error) => {
        assert.match(err.message, /migration v2/);
        assert.match(err.message, /failed:/);
        assert.match(err.message, /kaboom/);
        return true;
      },
    );
    // v1 committed, v2 rolled back.
    assert.equal(db.pragma("user_version", { simple: true }), 1, "user_version stays at 1");
    const v1 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='probe_v1'")
      .get();
    const v2 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='probe_v2'")
      .get();
    assert.ok(v1, "v1's table must survive");
    assert.equal(v2, undefined, "v2's partial write must be rolled back");
  });

  it("refuses a DB newer than supported without mutating it", () => {
    const db = newRaw();
    db.pragma("user_version = 99");
    let ran = false;
    assert.throws(
      () => migrate(db, [{ version: 1, name: "one", up: () => (ran = true) }]),
      /newer than supported/,
    );
    assert.equal(ran, false, "no up should run against a newer DB");
    assert.equal(db.pragma("user_version", { simple: true }), 99, "version must be untouched");
  });
});

describe("storage/migrations — LibretaDB.init() integration", () => {
  it("fresh DB is stamped to LATEST_SCHEMA_VERSION and has the core objects", () => {
    const db = newSpDb("fresh");
    db.init();
    const raw = rawOf(db);
    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
    for (const name of ["observations", "sessions", "observations_fts", "bitacora"]) {
      const row = raw
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get(name);
      assert.ok(row, `${name} object must exist`);
    }
    db.close();
  });

  it("an existing v0.1 DB (user_version=0) migrates to latest without losing data", () => {
    const path = join(workDir, "v01-fixture.db");
    const N = 7;
    const M = 3;

    // Build a genuine v0.1-shaped DB: run SCHEMA_SQL on a raw file, seed rows,
    // leave user_version at the SQLite default (0).
    const seed = new Database(path);
    seed.exec(SCHEMA_SQL);
    assert.equal(seed.pragma("user_version", { simple: true }), 0);
    const insObs = seed.prepare(
      `INSERT INTO observations
       (id, project, session_id, topic_key, title, type, what, why, where_, learned, created_at, updated_at)
       VALUES (@id, @project, NULL, NULL, @title, @type, @what, @why, @where_, @learned, @created_at, @updated_at)`,
    );
    const now = new Date().toISOString();
    for (let i = 0; i < N; i++) {
      insObs.run({ id: `obs-${i}`, created_at: now, updated_at: now, ...seedObs, title: `obs ${i}` });
    }
    const insSess = seed.prepare(
      `INSERT INTO sessions (id, project, started_at, observation_count) VALUES (?, ?, ?, 0)`,
    );
    for (let i = 0; i < M; i++) insSess.run(`sess-${i}`, "libreta", now);
    seed.close();

    // Reopen the *same* file with LibretaDB and migrate.
    const migrated = new LibretaDB(path);
    openHandles.push(migrated);
    migrated.init();

    const raw = rawOf(migrated);
    assert.equal(
      raw.pragma("user_version", { simple: true }),
      LATEST_SCHEMA_VERSION,
      "must end at the latest version",
    );
    const stats = migrated.stats();
    assert.equal(stats.observations, N, "observation count preserved");
    assert.equal(stats.sessions, M, "session count preserved");
    // Sample content unchanged.
    const sample = migrated.getById("obs-3");
    assert.ok(sample);
    assert.equal(sample.title, "obs 3");
    assert.equal(sample.learned, seedObs.learned);
    migrated.close();
  });

  it("migrating a v1 DB (observations only, no bitacora) adds the table without touching data", () => {
    const path = join(workDir, "v1-to-v2-fixture.db");

    // Build a genuine v1-shaped DB: baseline schema + user_version=1, seed
    // observations, and NO bitacora table.
    const seed = new Database(path);
    seed.exec(SCHEMA_SQL);
    seed.pragma("user_version = 1");
    const now = new Date().toISOString();
    seed
      .prepare(
        `INSERT INTO observations
         (id, project, session_id, topic_key, title, type, what, why, where_, learned, created_at, updated_at)
         VALUES (@id, @project, NULL, NULL, @title, @type, @what, @why, @where_, @learned, @created_at, @updated_at)`,
      )
      .run({ id: "obs-keep", created_at: now, updated_at: now, ...seedObs, title: "keep me" });
    const bitaBefore = seed
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bitacora'")
      .get();
    assert.equal(bitaBefore, undefined, "v1 fixture must NOT have bitacora yet");
    seed.close();

    // Reopen with LibretaDB and migrate forward.
    const migrated = new LibretaDB(path);
    openHandles.push(migrated);
    migrated.init();
    const raw = rawOf(migrated);

    assert.equal(
      raw.pragma("user_version", { simple: true }),
      LATEST_SCHEMA_VERSION,
      "must reach latest version",
    );
    const bitaAfter = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bitacora'")
      .get();
    assert.ok(bitaAfter, "bitacora table must exist after migrate");
    // Pre-existing data untouched.
    const kept = migrated.getById("obs-keep");
    assert.ok(kept);
    assert.equal(kept.title, "keep me");
    assert.equal(migrated.stats().observations, 1);

    // Idempotent: a second init() is a no-op (no throw, version stable).
    migrated.init();
    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
    migrated.close();
  });

  it("init() does NOT re-run SCHEMA_SQL on an already-stamped DB", () => {
    // MODIFIED requirement: after this change SCHEMA_SQL only runs when
    // user_version < 1, so an out-of-band dropped table is no longer silently
    // recreated. We observe that by dropping a table then re-initialising.
    const db = newSpDb("no-rerun");
    db.init();
    const raw = rawOf(db);
    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
    raw.exec("DROP TABLE sessions");
    db.init(); // second open — must be a no-op, not a re-create.
    const sessions = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get();
    assert.equal(sessions, undefined, "SCHEMA_SQL must not re-run to recreate the dropped table");
    db.close();
  });

  it("migrating a v6 DB with data adds tool_calls as NULL and leaves observations, bitácora and token totals intact", () => {
    const path = join(workDir, "v6-to-v7-fixture.db");
    const now = new Date().toISOString();

    const seed = new Database(path);
    for (const m of MIGRATIONS.filter((x) => x.version <= 5)) m.up(seed);
    seed.exec(V6_AGENT_TOKEN_USAGE_SQL);
    seed.pragma("user_version = 6");

    seed
      .prepare(
        `INSERT INTO observations
         (id, project, session_id, topic_key, title, type, what, why, where_, learned, created_at, updated_at)
         VALUES (@id, @project, NULL, NULL, @title, @type, @what, @why, @where_, @learned, @created_at, @updated_at)`,
      )
      .run({ id: "obs-v6", created_at: now, updated_at: now, ...seedObs, title: "survives v7" });
    seed
      .prepare(
        `INSERT INTO bitacora (id, project, date, headline, summary, linked_ids, created_at)
         VALUES (?, ?, ?, ?, ?, '[]', ?)`,
      )
      .run("bit-v6", "libreta", "2026-08-21", "headline v6", "summary v6", now);
    seed
      .prepare(
        `INSERT INTO agent_token_usage
         (session_id, agent_id, model, agent, task_type, description, tool_use_id, spawn_depth,
          duration_ms, turns, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          out_thinking, out_prose, out_tool_call, out_code, out_test, out_doc, thinking_method,
          partial, ingested_at)
         VALUES ('sess-v6', 'a1', 'claude-opus-5', 'coder', 'apply', 'APPLY x', 'toolu_1', 1,
                 null, 3, 10, 100, 1000, 50000, 10, 20, 30, 40, 0, 0, 'measured', 0, @now)`,
      )
      .run({ now });
    assert.equal(
      (
        seed
          .prepare("SELECT COUNT(*) c FROM pragma_table_info('agent_token_usage') WHERE name='tool_calls'")
          .get() as { c: number }
      ).c,
      0,
      "v6 fixture must NOT carry tool_calls yet",
    );
    seed.close();

    const migrated = new LibretaDB(path);
    openHandles.push(migrated);
    migrated.init();
    const raw = rawOf(migrated);

    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
    const col = raw
      .prepare("SELECT type, [notnull], dflt_value FROM pragma_table_info('agent_token_usage') WHERE name='tool_calls'")
      .get() as { type: string; notnull: number; dflt_value: unknown } | undefined;
    assert.ok(col, "tool_calls column must exist after v7");
    assert.equal(col.type, "INTEGER");
    assert.equal(col.notnull, 0, "the column must be nullable: NULL is the gap");
    assert.equal(col.dflt_value, null, "no DEFAULT: a 0 must stay distinguishable from never-measured");

    const kept = migrated.getById("obs-v6");
    assert.ok(kept);
    assert.equal(kept.title, "survives v7");
    assert.equal(migrated.bitacoraDay("libreta", "2026-08-21")[0]!.headline, "headline v6");

    const telemetry = migrated.telemetryQuery({ session_id: "sess-v6" });
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0]!.tool_calls, null, "a pre-counter row reads NULL, never 0");
    assert.equal(telemetry[0]!.out_tool_call, 30, "the byte-share figure is untouched by v7");
    assert.equal(telemetry[0]!.output_tokens, 100);
    migrated.close();
  });

  it("migrating a v7 DB with data creates the four telemetry-snapshot tables empty, at v8, without touching v7 data", () => {
    const path = join(workDir, "v7-to-v8-fixture.db");
    const now = new Date().toISOString();

    const seed = new Database(path);
    for (const m of MIGRATIONS.filter((x) => x.version <= 7)) m.up(seed);
    seed.pragma("user_version = 7");
    seed
      .prepare(
        `INSERT INTO observations
         (id, project, session_id, topic_key, title, type, what, why, where_, learned, created_at, updated_at)
         VALUES (@id, @project, NULL, NULL, @title, @type, @what, @why, @where_, @learned, @created_at, @updated_at)`,
      )
      .run({ id: "obs-v7", created_at: now, updated_at: now, ...seedObs, title: "survives v8" });
    seed
      .prepare(
        `INSERT INTO agent_token_usage
         (session_id, agent_id, model, agent, task_type, description, tool_use_id, spawn_depth,
          duration_ms, turns, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          out_thinking, out_prose, out_tool_call, out_code, out_test, out_doc, thinking_method,
          tool_calls, partial, ingested_at)
         VALUES ('sess-v7', 'a1', 'claude-opus-5', 'coder', 'apply', 'APPLY x', 'toolu_1', 1,
                 null, 3, 10, 100, 1000, 50000, 10, 20, 30, 40, 0, 0, 'measured', 5, 0, @now)`,
      )
      .run({ now });
    seed.close();

    const migrated = new LibretaDB(path);
    openHandles.push(migrated);
    migrated.init();
    const raw = rawOf(migrated);

    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
    for (const name of [
      "telemetry_snapshot",
      "telemetry_snapshot_total",
      "telemetry_snapshot_output_class",
      "telemetry_snapshot_note",
    ]) {
      const row = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
      assert.ok(row, `${name} table must exist after v8`);
      const count = raw.prepare(`SELECT COUNT(*) c FROM ${name}`).get() as { c: number };
      assert.equal(count.c, 0, `${name} must be empty right after migration`);
    }

    const kept = migrated.getById("obs-v7");
    assert.ok(kept);
    assert.equal(kept.title, "survives v8");
    const telemetry = migrated.telemetryQuery({ session_id: "sess-v7" });
    assert.equal(telemetry.length, 1, "existing agent_token_usage row survives v8 untouched");
    assert.equal(telemetry[0]!.tool_calls, 5);
    assert.equal(telemetry[0]!.output_tokens, 100);
    const colCount = raw.prepare("SELECT COUNT(*) c FROM pragma_table_info('agent_token_usage')").get() as {
      c: number;
    };
    assert.equal(colCount.c, 24, "agent_token_usage must gain no columns from v8");

    // Idempotent re-run: migrating an already-v8 DB again is a no-op.
    migrated.init();
    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
    for (const name of ["telemetry_snapshot", "telemetry_snapshot_total", "telemetry_snapshot_output_class"]) {
      const count = raw.prepare(`SELECT COUNT(*) c FROM ${name}`).get() as { c: number };
      assert.equal(count.c, 0, `${name} still empty after a second init()`);
    }
    migrated.close();
  });

  it("v8 tables accept explicit NULL for tool_calls/tool_calls_gap/author without a DEFAULT masking it as 0/''", () => {
    const db = newRaw();
    for (const m of MIGRATIONS) m.up(db);
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);

    db.prepare(
      `INSERT INTO telemetry_snapshot (id, taken_at, reason, session_id, schema_version)
       VALUES ('snap-1', '2026-08-24T00:00:00.000Z', 'pre-replace', 'sess-1', ?)`,
    ).run(LATEST_SCHEMA_VERSION);

    db.prepare(
      `INSERT INTO telemetry_snapshot_total
       (snapshot_id, axis, group_key, input_tokens, output_tokens, cache_creation_tokens,
        cache_read_tokens, turns, sessions, tool_calls, tool_calls_gap)
       VALUES ('snap-1', 'total', '', 10, 20, 0, 0, 1, 1, NULL, 'tool-calls-not-counted')`,
    ).run();

    db.prepare(
      `INSERT INTO telemetry_snapshot_note (id, snapshot_id, created_at, author, text)
       VALUES ('note-1', 'snap-1', '2026-08-24T00:00:00.000Z', NULL, 'no author yet')`,
    ).run();

    const total = db
      .prepare("SELECT tool_calls, tool_calls_gap FROM telemetry_snapshot_total WHERE snapshot_id='snap-1'")
      .get() as { tool_calls: number | null; tool_calls_gap: string | null };
    assert.equal(total.tool_calls, null, "tool_calls must round-trip as a real NULL, not 0");
    assert.equal(total.tool_calls_gap, "tool-calls-not-counted");

    const note = db
      .prepare("SELECT author FROM telemetry_snapshot_note WHERE id='note-1'")
      .get() as { author: string | null };
    assert.equal(note.author, null, "author must round-trip as a real NULL, not ''");
    db.close();
  });
});
