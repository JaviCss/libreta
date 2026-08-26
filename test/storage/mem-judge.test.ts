/**
 * Tests for mem_judge Lote 1 (change `mem-judge`):
 *   - migration v4: creates the `observation_relations` table
 *   - `findCandidates(obsId, opts?)`: FTS5 deterministic candidate finder
 *   - bucket isolation + BM25 floor
 *
 * Uses a temp DB file per test, closed and removed in `after`. Never touches
 * the user's real ~/.libreta DB.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
const openDbs: Array<{ close: () => void }> = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-memjudge-"));
});

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
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

const { LibretaDB, SCHEMA_SQL, BITACORA_SCHEMA_SQL, MIGRATIONS, LATEST_SCHEMA_VERSION } =
  await import("../../src/storage/libreta-db.js");
const Database = (await import("better-sqlite3")).default;

type RawHandle = import("better-sqlite3").Database;

function rawOf(db: InstanceType<typeof LibretaDB>): RawHandle {
  return (db as unknown as { db: RawHandle }).db;
}

function newDb(name: string): InstanceType<typeof LibretaDB> {
  const db = new LibretaDB(join(workDir, `${name}.db`));
  db.init();
  openDbs.push(db);
  return db;
}

// Reused shape — a `preference` observation under `criteria:<persona>`.
const crit = {
  project: "libreta",
  type: "preference" as const,
  what: "personal validation criterion",
  why: "personal definition of done",
  where: "-",
  learned: "-",
};

// ───────────────────────────────────────────────────────────────────────────
// Migration v4 — observation_relations table
// ───────────────────────────────────────────────────────────────────────────

describe("mem-judge — migration v4 (observation_relations table)", () => {
  it("appends v4 to the registry as a new entry (dense, last entry v4 + a v5+ may follow)", () => {
    // After change `mem-judge` Lote 3 (soft-deprecate) the registry has a v5
    // too. We assert the v4 invariants ("v4 is registered", "v4 is append-only
    // over v1/v2/v3") rather than pinning user_version to 4 — Lote 3 tests
    // assert the v5 invariants on a fresh DB.
    assert.ok(MIGRATIONS.length >= 4);
    assert.equal(MIGRATIONS[3]!.version, 4, "the 4th migration entry is v4");
    // Every prior migration's version is still 1, 2, 3 (not renumbered).
    assert.deepEqual(
      MIGRATIONS.slice(0, 3).map((m) => m.version),
      [1, 2, 3],
      "v1/v2/v3 versions unchanged (append-only)",
    );
  });

  it("fresh DB ends at LATEST_SCHEMA_VERSION with observation_relations created (UNIQUE pair)", () => {
    const db = newDb("v4-fresh");
    const raw = rawOf(db);
    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);

    const table = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_relations'")
      .get();
    assert.ok(table, "observation_relations table must exist");

    // Required columns present with the expected types/affinities.
    const cols = raw
      .prepare<[], { name: string; type: string; notnull: number; pk: number }>(
        "PRAGMA table_info(observation_relations)",
      )
      .all();
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const required of [
      "obs_a_id",
      "obs_b_id",
      "relation",
      "confidence",
      "reasoning",
      "created_at",
      "updated_at",
    ]) {
      assert.ok(byName.has(required), `column ${required} must exist on observation_relations`);
    }
    // NULL-vulnerable columns: pair ids, relation, reasoning, timestamps.
    for (const nn of ["obs_a_id", "obs_b_id", "relation", "reasoning", "created_at", "updated_at"]) {
      assert.equal(byName.get(nn)!.notnull, 1, `column ${nn} must be NOT NULL`);
    }
    assert.equal(byName.get("confidence")!.type.toUpperCase(), "REAL", "confidence is REAL");

    // UNIQUE(obs_a_id, obs_b_id) — enforced via the composite primary key on
    // the pair. (We use PRIMARY KEY (obs_a_id, obs_b_id) which is the
    // canonical way to encode "unique pair, no surrogate id" in SQLite.)
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    assert.deepEqual(
      pkCols.sort(),
      ["obs_a_id", "obs_b_id"].sort(),
      "composite PK on (obs_a_id, obs_b_id) enforces the unique pair",
    );

    db.close();
  });

  it("idempotent: a second init() does not re-run v4 and keeps user_version at LATEST_SCHEMA_VERSION", () => {
    const db = newDb("v4-idempotent");
    const raw = rawOf(db);
    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
    db.init();
    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
    // Table still exists, still empty.
    const cnt = (
      raw.prepare<[], { c: number }>("SELECT count(*) AS c FROM observation_relations").get()
    )?.c;
    assert.equal(cnt, 0);
    db.close();
  });

  it("non-destructive: migrating a v0 DB (no version stamp) preserves observations + sessions and adds the relations table", () => {
    const path = join(workDir, "v0-to-v4-fixture.db");
    // Build a genuine v0.1-shape DB: run baseline schema, seed rows,
    // leave user_version at the SQLite default (0). No bitacora, no dedup
    // fields, no relations — that's exactly the shape the v1→v2→v3→v4 chain
    // must walk forward without losing data.
    const seed = new Database(path);
    seed.exec(SCHEMA_SQL);
    assert.equal(seed.pragma("user_version", { simple: true }), 0);
    const now = new Date().toISOString();
    const insObs = seed.prepare(
      `INSERT INTO observations
       (id, project, session_id, topic_key, title, type, what, why, where_, learned, created_at, updated_at)
       VALUES (@id, @project, NULL, @tk, @title, 'architecture', 'w', 'y', 'wh', 'l', @n, @n)`,
    );
    const insSess = seed.prepare(
      "INSERT INTO sessions (id, project, started_at, observation_count) VALUES (?, ?, ?, 0)",
    );
    for (let i = 0; i < 5; i++) {
      insObs.run({
        id: `obs-${i}`,
        project: "libreta",
        tk: i % 2 === 0 ? `criteria:coder` : null,
        title: `seeded title ${i}`,
        n: now,
      });
    }
    insSess.run("sess-0", "libreta", now);
    insSess.run("sess-1", "libreta", now);
    seed.close();

    // Reopen with LibretaDB → run the full v1→v4 chain (and v5 if registered).
    const migrated = new LibretaDB(path);
    openDbs.push(migrated);
    migrated.init();
    const raw = rawOf(migrated);
    assert.equal(raw.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);

    // Data intact.
    assert.equal(migrated.stats().observations, 5);
    assert.equal(migrated.stats().sessions, 2);
    const sample = migrated.getById("obs-3");
    assert.ok(sample);
    assert.equal(sample.title, "seeded title 3");

    // The new table exists and is empty (we never inserted any rows).
    const relTable = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_relations'")
      .get();
    assert.ok(relTable);
    const relCnt = (
      raw.prepare<[], { c: number }>("SELECT count(*) AS c FROM observation_relations").get()
    )?.c;
    assert.equal(relCnt, 0);

    migrated.close();
  });

  it("non-destructive: a v3 DB (user_version=3) gets the relations table on init() without losing data", () => {
    const path = join(workDir, "v3-to-v4-fixture.db");
    // Build a v3-shaped DB directly with raw SQL so we can isolate the
    // v3→v4 step. We need v1 schema + v2 bitacora + v3 dedup fields, all
    // stamped at user_version=3, no relations table.
    const seed = new Database(path);
    seed.exec(SCHEMA_SQL);
    seed.exec(BITACORA_SCHEMA_SQL);
    seed.exec("ALTER TABLE observations ADD COLUMN content_hash TEXT");
    seed.exec("ALTER TABLE observations ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 1");
    // Seed an observation with a stub content_hash (the migration only cares
    // about the column being populated; the v3 backfill logic is tested
    // separately in libreta-dedup.test.ts).
    const now = new Date().toISOString();
    seed
      .prepare(
        `INSERT INTO observations
         (id, project, session_id, topic_key, title, type, what, why, where_, learned,
          content_hash, revision_count, created_at, updated_at)
         VALUES (?, 'libreta', NULL, ?, 'arch', 'architecture', 'w', 'y', 'wh', 'l',
                 'stub-hash', 1, ?, ?)`,
      )
      .run("obs-v3", "criteria:coder", now, now);
    seed.pragma("user_version = 3");
    const relBefore = seed
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_relations'")
      .get();
    assert.equal(relBefore, undefined, "v3 fixture must NOT have observation_relations yet");
    seed.close();

    // Reopen with LibretaDB and migrate forward.
    const migrated = new LibretaDB(path);
    openDbs.push(migrated);
    migrated.init();
    const raw = rawOf(migrated);

    assert.equal(
      raw.pragma("user_version", { simple: true }),
      LATEST_SCHEMA_VERSION,
      `reaches latest (v4 + any subsequent migrations like v5 soft-deprecate)`,
    );
    const relAfter = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_relations'")
      .get();
    assert.ok(relAfter, "observation_relations exists after migrate");
    // Original observation preserved.
    const kept = migrated.getById("obs-v3");
    assert.ok(kept);
    assert.equal(kept.topic_key, "criteria:coder");
    assert.equal(kept.revision_count, 1);

    migrated.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// findCandidates — FTS5 candidate finder
// ───────────────────────────────────────────────────────────────────────────

describe("mem-judge — findCandidates (FTS5 deterministic candidate finder)", () => {
  it("returns candidates in the same bucket, ranked by BM25 (most relevant first), excluding the source row", () => {
    const db = newDb("find-basic");
    // Use realistic titles so BM25 produces scores in the default-floor range
    // (design.md default `-2.0` only filters when the scores are at least
    // that negative — see the floor suite below for a deeper test).
    const target = db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "always run tests before committing code changes",
    });
    // Strong near-duplicate — top hit.
    const nearDup = db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "always run tests before committing code to the repo",
    });
    // Weaker overlap — shares "tests" + "code" + "run".
    db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "tests must come first before writing implementation code",
    });
    // No token overlap in the same bucket — must NOT surface.
    db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "document public APIs with usage examples and snippets",
    });

    const candidates = db.findCandidates(target.id);
    assert.ok(candidates.length >= 1, "expected at least the strong near-duplicate");

    // Source row is excluded.
    assert.ok(
      candidates.every((c) => c.observation.id !== target.id),
      "source row must not appear in its own candidates",
    );

    // Top hit is the strong near-duplicate.
    assert.equal(candidates[0]!.observation.id, nearDup.id);

    // All candidates share the source's project + topic_key (bucket scope).
    for (const c of candidates) {
      assert.equal(c.observation.project, target.project);
      assert.equal(c.observation.topic_key, target.topic_key);
    }

    // Scores are sorted ascending (most negative = most relevant first).
    for (let i = 1; i < candidates.length; i++) {
      assert.ok(
        candidates[i - 1]!.score <= candidates[i]!.score,
        `scores must be non-decreasing; got ${candidates[i - 1]!.score} before ${candidates[i]!.score}`,
      );
    }
    // BM25 default direction: negative values; smaller (more negative) is more relevant.
    for (const c of candidates) {
      assert.ok(typeof c.score === "number");
      assert.ok(Number.isFinite(c.score));
    }

    db.close();
  });

  it("respects LIMIT (default 3, configurable via opts)", () => {
    const db = newDb("find-limit");
    const target = db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "always run tests before committing code changes",
    });
    // 5 rows with strong token overlap on the same bucket.
    for (let i = 0; i < 5; i++) {
      db.save({
        ...crit,
        topic_key: "criteria:coder",
        title: `always run tests before committing code changes variant-${i}`,
      });
    }

    const def = db.findCandidates(target.id);
    assert.equal(def.length, 3, "default limit is 3");

    const explicit = db.findCandidates(target.id, { limit: 5 });
    assert.equal(explicit.length, 5, "explicit limit is honored");

    const tiny = db.findCandidates(target.id, { limit: 1 });
    assert.equal(tiny.length, 1, "limit:1 returns exactly one");

    db.close();
  });

  it("returns [] for a missing obsId (no throw)", () => {
    const db = newDb("find-missing");
    const result = db.findCandidates("01HNONEXISTENT0000000000000");
    assert.deepEqual(result, []);
    db.close();
  });

  it("returns [] when the source obs is in a bucket with no other rows", () => {
    const db = newDb("find-lonely");
    const only = db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "lonely criterion lives alone in this bucket",
    });
    assert.deepEqual(db.findCandidates(only.id), []);
    db.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Bucket isolation + BM25 floor
// ───────────────────────────────────────────────────────────────────────────

describe("mem-judge — findCandidates bucket isolation + BM25 floor", () => {
  it("NEVER crosses persona buckets (criteria:coder cannot see criteria:revisor)", () => {
    const db = newDb("find-bucket-isolation");
    const target = db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "always run tests before committing code changes",
    });
    // Same title in a DIFFERENT persona bucket — must NOT leak in.
    db.save({
      ...crit,
      topic_key: "criteria:revisor",
      title: "always run tests before committing code changes",
    });
    // Same title in a DIFFERENT project — must NOT leak in.
    db.save({
      ...crit,
      project: "other-proj",
      topic_key: "criteria:coder",
      title: "always run tests before committing code changes",
    });
    // Same bucket, but a different topic (not criteria) — must NOT leak in.
    db.save({
      ...crit,
      topic_key: "memory-impl",
      title: "always run tests before committing code changes",
    });

    const candidates = db.findCandidates(target.id);
    for (const c of candidates) {
      assert.equal(c.observation.project, "libreta", "other project never leaks in");
      assert.equal(
        c.observation.topic_key,
        "criteria:coder",
        "other persona bucket never leaks in",
      );
      assert.notEqual(c.observation.id, target.id, "source row never appears in its own candidates");
    }
    // Sanity: no candidates at all here is the safe expectation for a
    // bucket whose only same-bucket neighbours are the source itself.
    // (The other "always run tests..." rows are filtered out by bucket
    // scope BEFORE they can contribute a candidate.)
    assert.equal(
      candidates.length,
      0,
      "with only cross-bucket decoys, the bucket-scoped finder returns []",
    );
    db.close();
  });

  it("respects the BM25 floor (every returned score passes the configured floor)", () => {
    const db = newDb("find-floor");
    const target = db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "always run tests before committing code changes",
    });
    // Weak overlap: shares only the word "always".
    db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "always document public APIs with examples for reviewers",
    });
    // Strong overlap: shares the whole phrase + an extra.
    db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "always run tests before committing code to the main branch",
    });

    // Lax floor — `0` keeps every FTS5 hit (bm25 is always negative for
    // matching rows). Both weak and strong should appear.
    const lax = db.findCandidates(target.id, { floor: 0 });
    assert.ok(lax.length >= 2, "lax floor returns both weak and strong matches");
    const weak = lax.find((c) => c.observation.title.includes("document"));
    const strong = lax.find((c) => c.observation.title.includes("main branch"));
    assert.ok(weak, "weak candidate present at lax floor");
    assert.ok(strong, "strong candidate present at lax floor");
    // BM25: smaller (more negative) is more relevant. The weak match has a
    // higher (less negative) score than the strong one.
    assert.ok(
      weak!.score > strong!.score,
      `weak score (${weak!.score}) should be higher (less relevant) than strong (${strong!.score})`,
    );

    // Strict floor — placed strictly between the two scores. The weak match
    // must be rejected; the strong match must remain.
    const strictFloor = (weak!.score + strong!.score) / 2;
    const strict = db.findCandidates(target.id, { floor: strictFloor });

    // Every returned score passes the configured floor.
    for (const c of strict) {
      assert.ok(
        c.score <= strictFloor,
        `score ${c.score} must satisfy score <= floor ${strictFloor}`,
      );
    }
    // The weak match is excluded; the strong match is preserved.
    assert.ok(
      !strict.some((c) => c.observation.title.includes("document")),
      "weak match excluded by strict floor",
    );
    assert.ok(
      strict.some((c) => c.observation.title.includes("main branch")),
      "strong match preserved by strict floor",
    );

    db.close();
  });

  it("default floor accepts every FTS5 hit (permissive on a fresh DB)", () => {
    // The implementation default is `0.0` — the most permissive reasonable
    // choice for mem_judge's advisory role on a fresh DB. Power users tighten
    // via `opts.floor`; this test pins that contract so a future change to
    // the default can't silently alter behaviour.
    const db = newDb("find-default-floor");
    const target = db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "use TDD for non-trivial code changes",
    });
    const nearDup = db.save({
      ...crit,
      topic_key: "criteria:coder",
      title: "use TDD on non-trivial code changes",
    });

    const defaultCands = db.findCandidates(target.id);
    const explicitLax = db.findCandidates(target.id, { floor: 0 });
    // Default == floor:0 on this corpus (both accept every FTS5 hit).
    assert.deepEqual(
      defaultCands.map((c) => c.observation.id),
      explicitLax.map((c) => c.observation.id),
      "default floor matches the explicit floor:0 contract",
    );
    assert.ok(defaultCands.length >= 1, "strong near-duplicate surfaces at the default floor");
    assert.equal(defaultCands[0]!.observation.id, nearDup.id);

    db.close();
  });
});
