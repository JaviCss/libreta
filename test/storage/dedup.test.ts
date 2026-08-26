/**
 * Tests for deterministic dedup (change libreta-dedup): migration v3
 * backfill and the insert-or-bump behavior of save().
 *
 * Uses a temp DB file per test run, closed and removed in `after`. Never
 * touches the user's real ~/.libreta DB.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
const openDbs: Array<{ close: () => void }> = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-dedup-"));
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

const { LibretaDB, SCHEMA_SQL, LATEST_SCHEMA_VERSION } = await import(
  "../../src/storage/libreta-db.js"
);
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

const baseObs = {
  project: "libreta",
  title: "Use libreta for memory",
  type: "architecture" as const,
  what: "Implemented persistent memory component",
  why: "User wanted 5th pata",
  where: "src/components/memory.ts",
  learned: "Mirror Engram's toolset but in TS",
};

describe("libreta-dedup — migration v3 backfill", () => {
  it("migrates a v2 DB with N rows (incl. duplicates) → backfilled hash, revision_count=1, N rows preserved, user_version=LATEST (v3 still backfills, v4 also runs)", () => {
    const path = join(workDir, "v2-to-v3.db");
    // Build a genuine v2-shaped DB: baseline schema + user_version=2, seed rows
    // (including a byte-identical duplicate pair the migration MUST preserve).
    const seed = new Database(path);
    seed.exec(SCHEMA_SQL);
    seed.pragma("user_version = 2");
    const now = new Date().toISOString();
    const ins = seed.prepare(
      `INSERT INTO observations
       (id, project, session_id, topic_key, title, type, what, why, where_, learned, created_at, updated_at)
       VALUES (@id, 'libreta', NULL, NULL, @title, 'architecture', @what, 'why', 'where', 'learned', @n, @n)`,
    );
    const N = 5;
    for (let i = 0; i < N; i++) {
      // rows 3 and 4 are byte-identical content → a pre-existing duplicate.
      const dup = i >= 3;
      ins.run({ id: `obs-${i}`, title: dup ? "dup" : `title ${i}`, what: dup ? "dup what" : `what ${i}`, n: now });
    }
    seed.close();

    const db = new LibretaDB(path);
    openDbs.push(db);
    db.init();

    const raw = rawOf(db);
    // After change `mem-judge` (Lote 1) the LATEST_SCHEMA_VERSION is 4 — the
    // v2 fixture walks forward through v3 (backfill) AND v4 (relations
    // table). The v3-backfill contract under test is unchanged: N rows
    // preserved, content_hash populated, revision_count=1, the pre-existing
    // duplicate pair still survives with a shared hash.
    assert.equal(
      raw.pragma("user_version", { simple: true }),
      LATEST_SCHEMA_VERSION,
      `must reach LATEST_SCHEMA_VERSION (${LATEST_SCHEMA_VERSION})`,
    );
    assert.ok(LATEST_SCHEMA_VERSION >= 3, "sanity: LATEST_SCHEMA_VERSION is at least 3");

    const rows = raw
      .prepare<[], { id: string; content_hash: string | null; revision_count: number }>(
        "SELECT id, content_hash, revision_count FROM observations",
      )
      .all();
    assert.equal(rows.length, N, "all N rows preserved (no dedup on migrate)");
    for (const r of rows) {
      assert.ok(r.content_hash && r.content_hash.length === 64, `row ${r.id} backfilled with a hash`);
      assert.equal(r.revision_count, 1, `row ${r.id} revision_count defaults to 1`);
    }
    // The pre-existing duplicate pair (obs-3, obs-4) share a hash but both survive.
    const h3 = rows.find((r) => r.id === "obs-3")!.content_hash;
    const h4 = rows.find((r) => r.id === "obs-4")!.content_hash;
    assert.equal(h3, h4, "identical content backfills to the same hash");

    // idx_obs_dedup index exists.
    const idx = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_obs_dedup'")
      .get();
    assert.ok(idx, "idx_obs_dedup must exist after v3");
    db.close();
  });
});

describe("libreta-dedup — save() insert-or-bump", () => {
  it("re-saving identical content bumps instead of duplicating (one row, revision_count=2, updated_at bumped, created_at/id stable, one FTS hit)", async () => {
    const db = newDb("bump");
    const first = db.save(baseObs);
    assert.equal(first.revision_count, 1);
    await new Promise((r) => setTimeout(r, 5));
    const second = db.save(baseObs);

    assert.equal(second.id, first.id, "same row id (no new row)");
    assert.equal(second.created_at, first.created_at, "created_at unchanged");
    assert.notEqual(second.updated_at, first.updated_at, "updated_at bumped");
    assert.equal(second.revision_count, 2, "revision_count incremented");

    assert.equal(db.stats().observations, 1, "exactly one row");
    const hits = db.search("libreta", { project: "libreta" });
    assert.equal(hits.length, 1, "FTS returns exactly one hit");
    db.close();
  });

  it("identical content, different topic_key (and null-vs-topic) → separate rows (NULL-safe bucket)", () => {
    const db = newDb("topic-bucket");
    db.save({ ...baseObs, topic_key: "A" });
    db.save({ ...baseObs, topic_key: "B" });
    db.save({ ...baseObs }); // null topic — its own bucket
    assert.equal(db.stats().observations, 3, "three distinct buckets → three rows");

    // A second null-topic identical save dedups against the first null-topic row.
    const nullBefore = db.list({ project: "libreta" }).filter((o) => o.topic_key === undefined);
    assert.equal(nullBefore.length, 1);
    db.save({ ...baseObs });
    assert.equal(db.stats().observations, 3, "null-topic re-save dedups, still three rows");
    const nullAfter = db.list({ project: "libreta" }).filter((o) => o.topic_key === undefined);
    assert.equal(nullAfter.length, 1);
    assert.equal(nullAfter[0]!.revision_count, 2, "null-topic row bumped");
    db.close();
  });

  it("identical content, different type → separate rows (type in hash)", () => {
    const db = newDb("type-bucket");
    db.save({ ...baseObs, type: "decision" });
    db.save({ ...baseObs, type: "gotcha" });
    assert.equal(db.stats().observations, 2, "different type → two rows");
    db.close();
  });

  it("genuinely different content → new row with revision_count=1", () => {
    const db = newDb("different");
    db.save(baseObs);
    const other = db.save({ ...baseObs, what: "A completely different thing happened" });
    assert.equal(db.stats().observations, 2);
    assert.equal(other.revision_count, 1);
    db.close();
  });

  it("whitespace-only difference dedups (normalize path through save)", () => {
    const db = newDb("ws");
    db.save(baseObs);
    db.save({ ...baseObs, what: "  Implemented   persistent  memory   component  " });
    assert.equal(db.stats().observations, 1, "whitespace-only diff dedups");
    db.close();
  });
});

describe("libreta-dedup — revision_count on read paths", () => {
  it("revision_count round-trips through save/getById/list/search", () => {
    const db = newDb("round-trip");
    const saved = db.save(baseObs);
    db.save(baseObs); // bump to 2
    assert.equal(saved.revision_count, 1);

    const got = db.getById(saved.id);
    assert.ok(got);
    assert.equal(got.revision_count, 2, "getById exposes revision_count");

    const listed = db.list({ project: "libreta" });
    assert.equal(listed[0]!.revision_count, 2, "list exposes revision_count");

    const hits = db.search("libreta", { project: "libreta" });
    assert.equal(hits[0]!.observation.revision_count, 2, "search exposes revision_count");
    db.close();
  });
});
