/**
 * Tests for storage/libreta-db.ts — SQLite + FTS5 + ULID.
 *
 * Uses a temp DB file per test run, closed and removed in `after`.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWindows } from "../../src/utils/platform.js";

let workDir: string;
const openDbs: Array<{ close: () => void }> = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-spdb-"));
});

afterEach(() => {
  // Close any DBs that weren't explicitly closed by the test, so Windows
  // releases the file lock before the global `after` tries to rm the dir.
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
});

after(async () => {
  // Best-effort cleanup; ignore EBUSY on Windows (SQLite WAL linger).
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const { LibretaDB, SCHEMA_SQL } = await import("../../src/storage/libreta-db.js");
const Database = (await import("better-sqlite3")).default;

type RawHandle = import("better-sqlite3").Database;

/** Reach into LibretaDB's private handle to read pragmas the public surface
 * does not expose. Mirrors the cast used in the MCP tests. */
function rawOf(db: LibretaDB): RawHandle {
  return (db as unknown as { db: RawHandle }).db;
}

function newDb(name: string): LibretaDB {
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

describe("storage/libreta-db", () => {
  it("init() creates tables on a fresh DB", () => {
    const db = newDb("init");
    const tables = db
      .stats()
      ; // forces at least one query, no throw means tables exist
    assert.equal(typeof tables.observations, "number");
    assert.equal(typeof tables.sessions, "number");
    db.close();
  });

  it("save() creates an observation with ULID and ISO timestamps", () => {
    const db = newDb("save");
    const obs = db.save(baseObs);
    assert.match(obs.id, /^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID alphabet
    assert.match(obs.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(obs.created_at, obs.updated_at);
    db.close();
  });

  it("save() with session_id persists the link", () => {
    const db = newDb("save-session");
    const session = db.startSession("libreta");
    const obs = db.save({ ...baseObs, session_id: session.id });
    const fetched = db.getById(obs.id);
    assert.ok(fetched);
    assert.equal(fetched.session_id, session.id);
    db.close();
  });

  it("update() patches fields and bumps updated_at", async () => {
    const db = newDb("update");
    const obs = db.save(baseObs);
    await new Promise((r) => setTimeout(r, 5));
    const updated = db.update(obs.id, { title: "Renamed title" });
    assert.ok(updated);
    assert.equal(updated.title, "Renamed title");
    assert.notEqual(updated.updated_at, obs.updated_at, "updated_at should bump");
    assert.equal(updated.created_at, obs.created_at, "created_at should NOT change");
    db.close();
  });

  it("delete() removes the observation", () => {
    const db = newDb("delete");
    const obs = db.save(baseObs);
    assert.equal(db.delete(obs.id), true);
    assert.equal(db.getById(obs.id), null);
    assert.equal(db.delete(obs.id), false, "second delete returns false");
    db.close();
  });

  it("getById() returns null for missing id", () => {
    const db = newDb("getbyid");
    assert.equal(db.getById("01HNONEXISTENT0000000000000"), null);
    db.close();
  });

  it("search() finds observations by FTS5 match", () => {
    const db = newDb("search");
    db.save({ ...baseObs, title: "Use libreta for memory" });
    db.save({
      ...baseObs,
      title: "Other note",
      what: "Nothing related here",
      learned: "unrelated",
    });
    const results = db.search("libreta");
    assert.ok(results.length >= 1, "expected at least one hit");
    const top = results[0]!;
    assert.match(top.snippet, /<mark>|libreta/i);
    db.close();
  });

  it("list() returns observations newest-first", async () => {
    const db = newDb("list");
    const a = db.save(baseObs);
    // small sleep so the second observation has a strictly later timestamp
    await new Promise((r) => setTimeout(r, 10));
    const b = db.save({ ...baseObs, title: "Second" });
    const items = db.list({ project: "libreta", limit: 10 });
    assert.equal(items.length, 2);
    assert.equal(items[0]!.id, b.id, "newest should be first");
    assert.equal(items[1]!.id, a.id, "oldest should be last");
    db.close();
  });

  it("startSession() + endSession() cycle works", () => {
    const db = newDb("session");
    const s = db.startSession("libreta");
    assert.ok(s.id);
    assert.equal(s.ended_at, undefined);
    db.save({ ...baseObs, session_id: s.id });
    const ended = db.endSession(s.id, "Did the work");
    assert.ok(ended);
    assert.ok(ended.ended_at);
    assert.equal(ended.summary, "Did the work");
    db.close();
  });

  it("exportAll() + importAll() roundtrip preserves data", () => {
    const db = newDb("export");
    const session = db.startSession("libreta");
    db.save({ ...baseObs, session_id: session.id });
    db.save({ ...baseObs, title: "Second observation" });
    const exported = db.exportAll();
    assert.ok(exported.observations.length >= 2);
    assert.ok(exported.sessions.length >= 1);

    // Import into a fresh DB
    const db2 = newDb("import");
    const counts = db2.importAll(exported);
    assert.equal(counts.observations, exported.observations.length);
    assert.equal(counts.sessions, exported.sessions.length);
    db2.close();
    db.close();
  });

  it("importAll() preserves revision_count and backfills content_hash", () => {
    // Build a source row with revision_count > 1 by saving identical content
    // twice (the second save dedups and bumps the existing row).
    const src = newDb("import-revcount-src");
    src.save(baseObs);
    src.save(baseObs); // dedup bump → revision_count = 2
    const exported = src.exportAll();
    const srcObs = exported.observations.find((o) => o.title === baseObs.title);
    assert.ok(srcObs, "source observation present in export");
    assert.equal(srcObs!.revision_count, 2, "source row bumped to revision_count 2");

    // Import into a fresh DB.
    const dst = newDb("import-revcount-dst");
    dst.importAll(exported);
    const imported = dst.list({ project: baseObs.project }).find((o) => o.title === baseObs.title);
    assert.ok(imported, "imported observation present");
    assert.equal(imported!.revision_count, 2, "revision_count survives roundtrip (not reset to 1)");
    assert.ok(
      imported!.content_hash && imported!.content_hash.length > 0,
      "content_hash backfilled on import (non-null)",
    );
    src.close();
    dst.close();
  });

  it("importAll() rows participate in dedup on a later identical save", () => {
    const src = newDb("import-dedup-src");
    src.save(baseObs);
    const exported = src.exportAll();

    const dst = newDb("import-dedup-dst");
    dst.importAll(exported);
    assert.equal(dst.list({ project: baseObs.project }).length, 1, "one imported row");

    // Save identical content into the same bucket → must dedup, not insert.
    dst.save(baseObs);
    const rows = dst.list({ project: baseObs.project });
    assert.equal(rows.length, 1, "identical save dedups against the imported row (no new row)");
    assert.equal(rows[0]!.revision_count, 2, "imported row was bumped, not duplicated");
    src.close();
    dst.close();
  });

  it("importAll() stays idempotent when the same payload is imported twice", () => {
    const src = newDb("import-idempotent-src");
    src.save(baseObs);
    src.save({ ...baseObs, title: "Another" });
    const exported = src.exportAll();

    const dst = newDb("import-idempotent-dst");
    const first = dst.importAll(exported);
    const second = dst.importAll(exported);
    assert.equal(first.observations, exported.observations.length, "first import inserts all rows");
    assert.equal(second.observations, 0, "second import inserts nothing (rows with existing id skipped)");
    assert.equal(
      dst.list({ project: baseObs.project }).length,
      exported.observations.length,
      "no duplicate rows after double import",
    );
    src.close();
    dst.close();
  });

  it("doctor() reports healthy on a fresh DB", () => {
    const db = newDb("doctor");
    const report = db.doctor();
    assert.equal(report.ok, true, `doctor issues: ${JSON.stringify(report.issues)}`);
    db.close();
  });

  it("doctor() reports healthy on a populated DB (Fase 10 fix: no more false-positive roundtrip)", () => {
    // Fase 10 regression test: the previous doctor() did an INSERT→SELECT→DELETE
    // roundtrip that racy-fired with WAL + AFTER DELETE triggers and reported
    // "FTS5 roundtrip failed" even when search worked fine. The new doctor()
    // skips the roundtrip and only checks schema + that search() works on
    // real data. This test ensures the fix doesn't regress on populated DBs.
    const db = newDb("doctor-populated");
    db.save(baseObs);
    db.save({ ...baseObs, project: "another" });
    const report = db.doctor();
    assert.equal(
      report.ok,
      true,
      `doctor should be ok on healthy populated DB; issues: ${JSON.stringify(report.issues)}`,
    );
    // The "roundtrip failed" message must never appear — period.
    for (const issue of report.issues) {
      assert.doesNotMatch(issue, /roundtrip/, "doctor must never mention the old roundtrip probe");
    }
    db.close();
  });

  it("stats() counts correctly", () => {
    const db = newDb("stats");
    db.save(baseObs);
    db.save({ ...baseObs, project: "other-project" });
    const stats = db.stats();
    assert.equal(stats.observations, 2);
    assert.equal(stats.projects, 2);
    assert.ok(stats.dbSizeBytes > 0);
    db.close();
  });

  it("sets busy_timeout to 5000ms on open", () => {
    const db = newDb("busy-timeout");
    assert.equal(rawOf(db).pragma("busy_timeout", { simple: true }), 5000);
    db.close();
  });

  it("doctor() reports no integrity issue on a healthy populated DB", () => {
    const db = newDb("integrity-healthy");
    db.save(baseObs);
    db.save({ ...baseObs, title: "Second" });
    const report = db.doctor();
    for (const issue of report.issues) {
      assert.doesNotMatch(
        issue,
        /^integrity check failed:/,
        `unexpected integrity issue on a healthy DB: ${issue}`,
      );
    }
    assert.equal(report.ok, true, `doctor issues: ${JSON.stringify(report.issues)}`);
    db.close();
  });

  it("doctor() reports ok:false with 'integrity check failed:' on a structurally corrupt DB", async () => {
    // Fixture recipe (per design): a *truncation* is NOT a reliable corrupt
    // fixture (a truncated WAL can replay clean, a truncated main file may just
    // fail to open). Instead build a valid rollback-journal DB (so all data
    // lands in the main file on close), then byte-patch the b-tree
    // header/cell-pointer region of page 2 — past the 100-byte file header — so
    // the file still OPENS but PRAGMA quick_check fails. Do NOT degrade this to
    // "quick_check returns ok on a healthy DB", which proves nothing.
    const path = join(workDir, "corrupt-fixture.db");
    const seed = new Database(path); // default rollback journal (no WAL)
    seed.exec(SCHEMA_SQL);
    const ins = seed.prepare(
      `INSERT INTO observations
       (id, project, session_id, topic_key, title, type, what, why, where_, learned, created_at, updated_at)
       VALUES (@id, 'p', NULL, NULL, @t, 'note', 'w', 'y', 'wh', 'l', @n, @n)`,
    );
    const now = new Date().toISOString();
    seed.transaction(() => {
      for (let i = 0; i < 300; i++) ins.run({ id: `id-${i}`, t: `title long text ${i}`, n: now });
    })();
    seed.close();

    // Byte-patch the cell-pointer region of page 2 (offset > 100).
    const buf = await readFile(path);
    let pageSize = buf.readUInt16BE(16);
    if (pageSize === 1) pageSize = 65536;
    assert.ok(buf.length >= pageSize * 2, "fixture must have at least 2 pages to corrupt");
    for (let i = pageSize + 8; i < pageSize + 40; i++) buf[i] = 0xff;
    await writeFile(path, buf);

    // Open with LibretaDB (opens successfully) and run doctor().
    const db = new LibretaDB(path);
    openDbs.push(db);
    const report = db.doctor();
    assert.equal(report.ok, false, "corrupt DB must report ok:false");
    assert.ok(
      report.issues.some((i) => i.startsWith("integrity check failed:")),
      `expected an 'integrity check failed:' issue; got ${JSON.stringify(report.issues)}`,
    );
    db.close();
  });

  it("doctor() report keeps the { ok, issues } shape", () => {
    const db = newDb("doctor-shape");
    const report = db.doctor();
    assert.equal(typeof report.ok, "boolean");
    assert.ok(Array.isArray(report.issues));
    db.close();
  });

  // ─── Security hardening (SEC-6/SEC-7) ───────────────────────────────────
  // SEC-6: on POSIX, a freshly created libreta DB file MUST be 0600
  // (owner rw only). Skip on Windows — there is no POSIX mode bit.
  const posixIt = isWindows() ? it.skip : it;
  posixIt("[SEC-6] a freshly created DB file has mode 0600 on POSIX", async () => {
    const path = join(workDir, "sec6-fresh.db");
    const db = new LibretaDB(path);
    openDbs.push(db);
    db.init();
    db.close();
    const s = await stat(path);
    // Mask to permission bits — some filesystems also report file type bits.
    assert.equal(s.mode & 0o777, 0o600, `expected 0600, got ${(s.mode & 0o777).toString(8)}`);
  });

  // SEC-7: initialization must NOT throw on non-POSIX platforms where chmod
  // is not available. Always runnable; on POSIX it just confirms the
  // platform branch is silent.
  it("[SEC-7] initialization does not throw on a non-POSIX-style chmod unavailable scenario", () => {
    // The implementation guards chmod with isWindows(), so on a Windows test
    // run it just skips — but we also exercise a fresh init here to confirm
    // the constructor path is clean (no chmod attempt on POSIX, no error on
    // Windows).
    const path = join(workDir, "sec7-clean-init.db");
    const db = new LibretaDB(path);
    openDbs.push(db);
    // Should not throw — initialize freely.
    assert.doesNotThrow(() => db.init());
    db.close();
  });

  // ─── Security hardening round 2 (SEC-12) ────────────────────────────────
  // SEC-12: when the libreta DB runs in WAL mode, better-sqlite3 creates
  // two sidecar files that ALSO hold plaintext observation data: `<db>-wal`
  // (write-ahead log) and `<db>-shm` (shared-memory index). chmod'ing only the
  // main DB file is a partial fix — the sidecars stay world-readable on POSIX
  // and the original review's promise ("we want them covered too") is broken.
  // Both MUST be 0600 after a write forces them into existence. POSIX-only —
  // Windows has no POSIX mode bits.
  //
  // Subtlety: in WAL mode the `-wal` is deleted on the final checkpoint at
  // close(), and `-shm` is removed by SQLite when the last connection
  // disconnects. The assertions MUST run while the connection is still open,
  // otherwise we would stat() files that no longer exist (ENOENT). To make
  // the test deterministic we also disable the auto-checkpoint threshold
  // (default 1000 pages) so a single observation write can never trigger an
  // in-flight checkpoint that would delete `-wal` between the write and the
  // assertion.
  posixIt("[SEC-12] WAL and SHM sidecars are 0600 on POSIX after a write", async () => {
    const path = join(workDir, "sec12-sidecars.db");
    const db = new LibretaDB(path);
    openDbs.push(db);
    db.init();
    // Belt-and-suspenders: disable auto-checkpoint so the -wal cannot be
    // deleted by an in-flight checkpoint between our write and our stat().
    // 0 means "never auto-checkpoint"; the file will still be deleted on
    // close() (which is exactly the behavior we rely on — we stat BEFORE
    // close()).
    rawOf(db).pragma("wal_autocheckpoint = 0");

    // Force the sidecars into existence with a real write (WAL mode lazily
    // creates them only on the first write transaction).
    db.save(baseObs);

    // Assert BEFORE close(): close() deletes `-wal` via the final checkpoint
    // and `-shm` via SQLite's "last connection disconnects" cleanup. A
    // round-trip through Windows confirmed this exact sequence (probe:
    //   step 4 [conn open]: probe.db + probe.db-wal + probe.db-shm
    //   step 6 [post close]: probe.db only — both sidecars gone).
    const walPath = `${path}-wal`;
    const shmPath = `${path}-shm`;
    assert.ok(
      existsSync(walPath),
      `expected ${walPath} to exist after a write (WAL mode, before close)`,
    );
    assert.ok(
      existsSync(shmPath),
      `expected ${shmPath} to exist after a write (WAL mode, before close)`,
    );

    const walStat = await stat(walPath);
    const shmStat = await stat(shmPath);
    assert.equal(
      walStat.mode & 0o777,
      0o600,
      `expected -wal mode 0600, got ${(walStat.mode & 0o777).toString(8)}`,
    );
    assert.equal(
      shmStat.mode & 0o777,
      0o600,
      `expected -shm mode 0600, got ${(shmStat.mode & 0o777).toString(8)}`,
    );

    db.close();
  });
});
describe("storage/libreta-db — listCriteria (persona-criteria)", () => {
  const crit = {
    project: "libreta",
    type: "preference" as const,
    what: "personal validation criterion",
    why: "personal definition of done",
    where: "-",
    learned: "-",
  };

  it("returns only preference rows with topic_key=criteria:<persona>, scoped by persona", () => {
    const db = newDb("criteria-scope");
    db.save({ ...crit, topic_key: "criteria:coder", title: "coder: tests first" });
    db.save({ ...crit, topic_key: "criteria:revisor", title: "revisor: re-run evidence" });
    // A non-criteria preference in the same project must NOT leak in.
    db.save({ ...crit, topic_key: "some-other-topic", title: "unrelated preference" });
    // A non-preference row sharing the topic_key must NOT leak in either.
    db.save({ ...crit, type: "gotcha" as const, topic_key: "criteria:coder", title: "not a preference" });

    const coder = db.listCriteria("coder");
    assert.equal(coder.length, 1, "only the one coder-criteria preference");
    assert.equal(coder[0]!.title, "coder: tests first");

    const revisor = db.listCriteria("revisor");
    assert.equal(revisor.length, 1);
    assert.equal(revisor[0]!.title, "revisor: re-run evidence");
    db.close();
  });

  it("orders by revision_count desc (most-confirmed first)", () => {
    const db = newDb("criteria-order");
    // low-confirmed criterion
    db.save({ ...crit, topic_key: "criteria:coder", title: "seldom" });
    // high-confirmed criterion: save identical content 3x → revision_count = 3
    const high = { ...crit, topic_key: "criteria:coder", title: "often" };
    db.save(high);
    db.save(high);
    db.save(high);

    const rows = db.listCriteria("coder");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.title, "often", "most-confirmed first");
    assert.equal(rows[0]!.revision_count, 3);
    assert.equal(rows[1]!.title, "seldom");
    db.close();
  });

  it("scopes by project when given", () => {
    const db = newDb("criteria-project");
    db.save({ ...crit, project: "libreta", topic_key: "criteria:coder", title: "here" });
    db.save({ ...crit, project: "other-proj", topic_key: "criteria:coder", title: "there" });

    const scoped = db.listCriteria("coder", "libreta");
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]!.title, "here");

    const all = db.listCriteria("coder");
    assert.equal(all.length, 2, "no project filter returns both");
    db.close();
  });

  it("includes a row saved AFTER a prior read (no cache staleness)", () => {
    const db = newDb("criteria-fresh");
    db.save({ ...crit, topic_key: "criteria:arquitecto", title: "first" });
    const before = db.listCriteria("arquitecto");
    assert.equal(before.length, 1);

    // Save a NEW criterion after the first read; it must appear on re-read.
    db.save({ ...crit, topic_key: "criteria:arquitecto", title: "second" });
    const after = db.listCriteria("arquitecto");
    assert.equal(after.length, 2, "row saved after the prior read is visible");
    db.close();
  });
});

describe("storage/libreta-db — bitácora", () => {
  const baseEntry = {
    project: "libreta",
    date: "2026-07-21",
    headline: "Shipped bitácora schema",
    summary: "Added the bitacora table + tools; migration v2 idempotent.",
    linked_ids: ["01OBSAAA", "01OBSBBB"],
  };

  it("addBitacora stores a day entry with a generated id + created_at and NO why/where", () => {
    const db = newDb("bita-add");
    const entry = db.addBitacora(baseEntry);
    assert.match(entry.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(entry.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(entry.headline, baseEntry.headline);
    assert.deepEqual(entry.linked_ids, baseEntry.linked_ids);
    // Distinct shape: none of the observation-only fields leak in.
    assert.equal((entry as Record<string, unknown>).why, undefined);
    assert.equal((entry as Record<string, unknown>).where, undefined);
    assert.equal((entry as Record<string, unknown>).learned, undefined);
    db.close();
  });

  it("bitacoraDay returns entries for that project+date (newest first), linked_ids round-tripped", async () => {
    const db = newDb("bita-day");
    // created_at is the newest-first sort key and has ms precision — space the
    // writes so "morning" < "evening" strictly holds (same trick as lib_timeline).
    db.addBitacora({ ...baseEntry, headline: "morning" });
    await new Promise((r) => setTimeout(r, 3));
    db.addBitacora({ ...baseEntry, headline: "evening", linked_ids: [] });
    db.addBitacora({ ...baseEntry, date: "2026-07-20", headline: "yesterday" });
    db.addBitacora({ ...baseEntry, project: "other", headline: "other project" });

    const day = db.bitacoraDay("libreta", "2026-07-21");
    assert.equal(day.length, 2);
    assert.deepEqual(
      day.map((e) => e.headline),
      ["evening", "morning"],
    );
    assert.deepEqual(day[1]!.linked_ids, baseEntry.linked_ids);
    assert.deepEqual(day[0]!.linked_ids, []);
    db.close();
  });

  it("bitacoraRange returns entries within [from,to] inclusive, ordered by date", () => {
    const db = newDb("bita-range");
    for (const d of ["2026-07-18", "2026-07-19", "2026-07-21", "2026-07-25"]) {
      db.addBitacora({ ...baseEntry, date: d, headline: d });
    }
    const range = db.bitacoraRange("libreta", "2026-07-19", "2026-07-21");
    assert.deepEqual(
      range.map((e) => e.date),
      ["2026-07-19", "2026-07-21"],
    );
    db.close();
  });
});
