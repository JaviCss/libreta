/**
 * Tests for MCP tools — lib_save, lib_search, lib_update, lib_session_*, lib_export/import, lib_stats.
 *
 * Each test instantiates an in-memory SQLite DB and a fake MCP request
 * shape, calls the tool's handler directly, and asserts the response.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { LibretaDB } = await import("../../../src/storage/libreta-db.js");
const { ALL_TOOLS } = await import("../../../src/mcp/tools/index.js");
const { MAX_IMPORT_BYTES } = await import("../../../src/storage/import-validation.js");

function toolByName(name: string) {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function parseResult(result: { content: Array<{ type: "text"; text: string }> }): unknown {
  return JSON.parse(result.content[0]!.text);
}

let workDir: string;
/** Directory inside the sandbox allowlist (~/.libreta with HOME=workDir). */
let sandboxDir: string;
let openDbs: LibretaDB[] = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-mcp-"));
  // Point HOME at the temp dir so the file sandbox (lib_export/lib_import)
  // allows paths under <workDir>/.libreta. Each test file runs in its own
  // process, so this doesn't leak into other suites.
  process.env.HOME = workDir;
  process.env.USERPROFILE = workDir;
  sandboxDir = join(workDir, ".libreta");
  await mkdir(sandboxDir, { recursive: true });
});

after(async () => {
  for (const db of openDbs) {
    try { db.close(); } catch { /* ignore */ }
  }
  try { await rm(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const db of openDbs) {
    try { db.close(); } catch { /* ignore */ }
  }
  openDbs = [];
});

function newDb(): LibretaDB {
  const path = join(workDir, `mcp-${Math.random().toString(36).slice(2)}.db`);
  const db = new LibretaDB(path);
  db.init();
  openDbs.push(db);
  return db;
}

const baseObs = {
  project: "libreta",
  title: "Test observation",
  type: "architecture" as const,
  what: "What happened",
  why: "Why this approach",
  where: "src/foo.ts",
  learned: "Takeaway",
};

describe("MCP tools — lib_save", () => {
  it("saves a valid observation and returns id + created_at", async () => {
    const db = newDb();
    const result = await toolByName("lib_save").handler(baseObs, db);
    const out = parseResult(result) as { id: string; created_at: string };
    assert.match(out.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(out.created_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an invalid type", async () => {
    const db = newDb();
    await assert.rejects(
      () => toolByName("lib_save").handler({ ...baseObs, type: "bogus-type" }, db),
      /Invalid type/,
    );
  });
});

describe("MCP tools — lib_search", () => {
  it("rejects empty query", async () => {
    const db = newDb();
    await assert.rejects(
      () => toolByName("lib_search").handler({ query: "" }, db),
      /query must not be empty/,
    );
  });

  it("returns bm25-ranked results with snippet containing <mark>", async () => {
    const db = newDb();
    db.save({ ...baseObs, title: "Use libreta for memory" });
    db.save({ ...baseObs, title: "Other note" });
    const result = await toolByName("lib_search").handler({ query: "libreta" }, db);
    const out = parseResult(result) as { results: Array<{ observation: { title: string }; snippet: string; score: number }> };
    assert.ok(out.results.length >= 1);
    assert.match(out.results[0]!.snippet, /<mark>/i);
    assert.ok(typeof out.results[0]!.score === "number");
  });
});

describe("MCP tools — lib_update", () => {
  it("returns updated=false for invalid id", async () => {
    const db = newDb();
    const result = await toolByName("lib_update").handler(
      { id: "01HNONEXISTENT0000000000000", patch: { title: "x" } },
      db,
    );
    const out = parseResult(result) as { updated: boolean };
    assert.equal(out.updated, false);
  });
});

describe("MCP tools — lib_session_start + lib_session_end", () => {
  it("full cycle returns consistent session metadata", async () => {
    const db = newDb();
    const startResult = await toolByName("lib_session_start").handler(
      { project: "libreta" },
      db,
    );
    const session = (parseResult(startResult) as { session: { id: string; ended_at?: string } }).session;
    assert.ok(session.id);
    assert.equal(session.ended_at, undefined);

    db.save({ ...baseObs, session_id: session.id });
    const endResult = await toolByName("lib_session_end").handler(
      { id: session.id, summary: "Done" },
      db,
    );
    const ended = (parseResult(endResult) as { session: { id: string; ended_at?: string; summary?: string } }).session;
    assert.ok(ended.ended_at);
    assert.equal(ended.summary, "Done");
  });
});

describe("MCP tools — lib_export + lib_import", () => {
  it("roundtrips a single observation through a JSON file", async () => {
    const db = newDb();
    const expResult = await toolByName("lib_export").handler(
      { file: join(sandboxDir, "export.json") },
      db,
    );
    assert.equal(
      (parseResult(expResult) as { path: string }).path,
      join(sandboxDir, "export.json"),
    );

    // Now import into a fresh DB
    const db2 = newDb();
    const impResult = await toolByName("lib_import").handler(
      { file: join(sandboxDir, "export.json") },
      db2,
    );
    const out = parseResult(impResult) as { imported: { observations: number; sessions: number } };
    assert.equal(out.imported.observations, 0); // empty export
    assert.equal(out.imported.sessions, 0);

    // Roundtrip with actual data
    db.save(baseObs);
    const db3 = newDb();
    await toolByName("lib_export").handler({ file: join(sandboxDir, "export2.json") }, db);
    await toolByName("lib_import").handler({ file: join(sandboxDir, "export2.json") }, db3);
    assert.equal(db3.list({ project: "libreta" }).length, 1);
  });
});

describe("MCP tools — lib_stats", () => {
  it("returns correct counts", async () => {
    const db = newDb();
    db.save(baseObs);
    db.save({ ...baseObs, title: "Second" });
    const result = await toolByName("lib_stats").handler({}, db);
    const out = parseResult(result) as { observations: number };
    assert.equal(out.observations, 2);
  });
});

describe("MCP tools — lib_export file actually exists on disk", () => {
  it("writes the JSON payload to the requested path", async () => {
    const db = newDb();
    db.save(baseObs);
    const out = join(sandboxDir, "check.json");
    await toolByName("lib_export").handler({ file: out }, db);
    const content = await readFile(out, "utf8");
    const parsed = JSON.parse(content) as { observations: unknown[]; version: number };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.observations.length, 1);
  });
});

describe("MCP tools — filesystem sandbox (Sprint 1 security)", () => {
  it("lib_export rejects a destination outside the allowed roots", async () => {
    const db = newDb();
    // workDir itself is NOT allowed — only workDir/.libreta and process.cwd().
    await assert.rejects(
      () => toolByName("lib_export").handler({ file: join(workDir, "escape.json") }, db),
      /outside allowed directories/,
    );
  });

  it("lib_export rejects '..' traversal even when it would resolve inside", async () => {
    const db = newDb();
    // Deliberately NOT join(): join() collapses `..` — the raw string is
    // what an attacker-controlled tool call would actually contain.
    await assert.rejects(
      () => toolByName("lib_export").handler({ file: `${sandboxDir}/sub/../ok.json` }, db),
      /'\.\.' segments/,
    );
  });

  it("lib_import rejects a source outside the allowed roots", async () => {
    const db = newDb();
    await assert.rejects(
      () => toolByName("lib_import").handler({ file: join(workDir, "outside.json") }, db),
      /outside allowed directories/,
    );
  });

});

describe("MCP tools — lib_import payload validation (Sprint 1 security)", () => {
  it("rejects a file bigger than MAX_IMPORT_BYTES before parsing it", async () => {
    const big = join(sandboxDir, "big.json");
    await writeFile(big, Buffer.alloc(MAX_IMPORT_BYTES + 1, 0x20));
    await assert.rejects(
      () => toolByName("lib_import").handler({ file: big }, newDb()),
      /too large/,
    );
  });

  it("rejects an unsupported version", async () => {
    const file = join(sandboxDir, "bad-version.json");
    await writeFile(file, JSON.stringify({ version: 99, observations: [], sessions: [] }));
    await assert.rejects(
      () => toolByName("lib_import").handler({ file }, newDb()),
      /unsupported version/,
    );
  });

  it("rejects an observation with an out-of-enum type, naming the index", async () => {
    const file = join(sandboxDir, "bad-type.json");
    const obs = {
      id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
      project: "p",
      title: "t",
      type: "not-a-type",
      what: "w",
      why: "y",
      where: ".",
      learned: "l",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(file, JSON.stringify({ version: 1, observations: [obs], sessions: [] }));
    await assert.rejects(
      () => toolByName("lib_import").handler({ file }, newDb()),
      /observations\[0\].*not-a-type/,
    );
  });

  it("rejects an observation missing a required field", async () => {
    const file = join(sandboxDir, "missing-field.json");
    await writeFile(
      file,
      JSON.stringify({ version: 1, observations: [{ id: "x" }], sessions: [] }),
    );
    await assert.rejects(
      () => toolByName("lib_import").handler({ file }, newDb()),
      /observations\[0\]/,
    );
  });

  it("rejects a session with a bogus observation_count", async () => {
    const file = join(sandboxDir, "bad-session.json");
    const sess = { id: "s1", project: "p", started_at: "2026-01-01", observation_count: "many" };
    await writeFile(file, JSON.stringify({ version: 1, observations: [], sessions: [sess] }));
    await assert.rejects(
      () => toolByName("lib_import").handler({ file }, newDb()),
      /observation_count/,
    );
  });
});

describe("MCP tools — lib_update patch validation (Sprint 1 security)", () => {
  it("rejects a patch touching a non-patchable field", async () => {
    const db = newDb();
    const saved = db.save(baseObs);
    await assert.rejects(
      () =>
        toolByName("lib_update").handler(
          { id: saved.id, patch: { created_at: "1970-01-01T00:00:00.000Z" } },
          db,
        ),
      /not allowed/,
    );
  });

  it("rejects a patch that breaks the type enum", async () => {
    const db = newDb();
    const saved = db.save(baseObs);
    await assert.rejects(
      () => toolByName("lib_update").handler({ id: saved.id, patch: { type: "bogus" } }, db),
      /Invalid type/,
    );
  });

  it("rejects an empty patch", async () => {
    const db = newDb();
    const saved = db.save(baseObs);
    await assert.rejects(
      () => toolByName("lib_update").handler({ id: saved.id, patch: {} }, db),
      /at least one field/,
    );
  });

  it("still applies a valid patch", async () => {
    const db = newDb();
    const saved = db.save(baseObs);
    const result = await toolByName("lib_update").handler(
      { id: saved.id, patch: { title: "Patched", type: "gotcha" } },
      db,
    );
    const out = parseResult(result) as { updated: boolean; observation: { title: string; type: string } };
    assert.equal(out.updated, true);
    assert.equal(out.observation.title, "Patched");
    assert.equal(out.observation.type, "gotcha");
  });
});

describe("MCP tools — lib_get / lib_delete", () => {
  it("lib_get returns the observation, or null when missing", async () => {
    const db = newDb();
    const saved = db.save(baseObs);
    const found = parseResult(await toolByName("lib_get").handler({ id: saved.id }, db)) as {
      observation: { id: string } | null;
    };
    assert.equal(found.observation?.id, saved.id);

    const missing = parseResult(
      await toolByName("lib_get").handler({ id: "01HNONEXISTENT0000000000000" }, db),
    ) as { observation: unknown };
    assert.equal(missing.observation, null);
  });

  it("lib_delete removes the row and reports deleted=false on a second call", async () => {
    const db = newDb();
    const saved = db.save(baseObs);
    const first = parseResult(await toolByName("lib_delete").handler({ id: saved.id }, db)) as {
      deleted: boolean;
    };
    assert.equal(first.deleted, true);
    assert.equal(db.getById(saved.id), null);

    const second = parseResult(await toolByName("lib_delete").handler({ id: saved.id }, db)) as {
      deleted: boolean;
    };
    assert.equal(second.deleted, false);
  });
});

describe("MCP tools — lib_context", () => {
  it("returns recent observations and the open session", async () => {
    const db = newDb();
    const session = db.startSession("libreta");
    db.save({ ...baseObs, session_id: session.id });
    db.save({ ...baseObs, title: "Second" });
    const out = parseResult(
      await toolByName("lib_context").handler({ project: "libreta" }, db),
    ) as { recent: unknown[]; current_session?: { id: string } };
    assert.equal(out.recent.length, 2);
    assert.equal(out.current_session?.id, session.id);
  });

  it("omits current_session when every session is closed", async () => {
    const db = newDb();
    const session = db.startSession("libreta");
    db.endSession(session.id, "done");
    const out = parseResult(
      await toolByName("lib_context").handler({ project: "libreta" }, db),
    ) as { current_session?: unknown };
    assert.equal(out.current_session, undefined);
  });
});

describe("MCP tools — lib_timeline", () => {
  it("returns neighbors before and after the target", async () => {
    const db = newDb();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(db.save({ ...baseObs, title: `obs ${i}` }).id);
      // created_at is the timeline sort key and has ms precision — avoid ties.
      await new Promise((r) => setTimeout(r, 2));
    }
    const out = parseResult(
      await toolByName("lib_timeline").handler({ id: ids[2]!, depth: 1 }, db),
    ) as { before: Array<{ id: string }>; after: Array<{ id: string }> };
    assert.equal(out.before.length, 1);
    assert.equal(out.after.length, 1);
    // list() is newest-first, so "before" holds the newer neighbor.
    assert.equal(out.before[0]!.id, ids[3]);
    assert.equal(out.after[0]!.id, ids[1]);
  });

  it("reports an error for an unknown id", async () => {
    const out = parseResult(
      await toolByName("lib_timeline").handler({ id: "01HNONEXISTENT0000000000000" }, newDb()),
    ) as { error?: string };
    assert.match(out.error ?? "", /not found/);
  });
});

describe("MCP tools — lib_review", () => {
  it("filters by `since` and respects `limit`", async () => {
    const db = newDb();
    db.save({ ...baseObs, title: "old" });
    // ISO timestamps have millisecond precision — space the saves out so
    // old < cutoff < newer strictly holds.
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    db.save({ ...baseObs, title: "newer" });
    const out = parseResult(
      await toolByName("lib_review").handler({ project: "libreta", since: cutoff }, db),
    ) as { observations: Array<{ title: string }> };
    assert.deepEqual(out.observations.map((o) => o.title), ["newer"]);

    const limited = parseResult(
      await toolByName("lib_review").handler({ project: "libreta", limit: 1 }, db),
    ) as { observations: unknown[] };
    assert.equal(limited.observations.length, 1);
  });
});

describe("MCP tools — lib_session_summary", () => {
  it("returns the session plus its observations only", async () => {
    const db = newDb();
    const session = db.startSession("libreta");
    db.save({ ...baseObs, session_id: session.id });
    db.save({ ...baseObs, title: "unrelated" }); // no session
    const out = parseResult(
      await toolByName("lib_session_summary").handler({ id: session.id }, db),
    ) as { session: { id: string }; observations: unknown[] };
    assert.equal(out.session.id, session.id);
    assert.equal(out.observations.length, 1);
  });

  it("reports an error for an unknown session", async () => {
    const out = parseResult(
      await toolByName("lib_session_summary").handler({ id: "nope" }, newDb()),
    ) as { error?: string };
    assert.match(out.error ?? "", /not found/);
  });
});
describe("MCP tools — lib_criteria (persona-criteria)", () => {
  const crit = {
    project: "libreta",
    type: "preference" as const,
    what: "personal validation criterion",
    why: "personal DoD",
    where: "-",
    learned: "-",
  };

  it("returns the persona-scoped criteria, ranked by revision_count desc", async () => {
    const db = newDb();
    db.save({ ...crit, topic_key: "criteria:coder", title: "seldom" });
    const often = { ...crit, topic_key: "criteria:coder", title: "often" };
    db.save(often);
    db.save(often); // revision_count = 2
    db.save({ ...crit, topic_key: "criteria:revisor", title: "revisor only" });

    const out = parseResult(
      await toolByName("lib_criteria").handler({ persona: "coder" }, db),
    ) as { criteria: Array<{ title: string; revision_count: number }> };
    assert.equal(out.criteria.length, 2, "only coder criteria, revisor excluded");
    assert.equal(out.criteria[0]!.title, "often", "most-confirmed first");
    assert.equal(out.criteria[0]!.revision_count, 2);
    assert.equal(out.criteria[1]!.title, "seldom");
  });

  it("errors clearly on an unknown persona", async () => {
    const db = newDb();
    await assert.rejects(
      () => toolByName("lib_criteria").handler({ persona: "bogus" }, db),
      /Unknown persona/,
    );
  });

  it("requires the persona argument", async () => {
    const db = newDb();
    await assert.rejects(
      () => toolByName("lib_criteria").handler({}, db),
      /persona is required/,
    );
  });

  it("returns an empty list (no error) when the persona has no criteria yet", async () => {
    const db = newDb();
    const out = parseResult(
      await toolByName("lib_criteria").handler({ persona: "lite" }, db),
    ) as { criteria: unknown[] };
    assert.deepEqual(out.criteria, []);
  });

  // Write path (convention only — proves no new write path is needed).
  it("a criterion saved via lib_save round-trips through lib_criteria; a second identical save dedups (bumps revision_count, no duplicate)", async () => {
    const db = newDb();
    const saveArgs = {
      ...crit,
      what: "run tests before signing off",
      topic_key: "criteria:arquitecto",
      title: "arquitecto: validate with revisor",
    };
    await toolByName("lib_save").handler(saveArgs, db);
    let out = parseResult(
      await toolByName("lib_criteria").handler({ persona: "arquitecto" }, db),
    ) as { criteria: Array<{ revision_count: number }> };
    assert.equal(out.criteria.length, 1, "round-trips through lib_criteria");
    assert.equal(out.criteria[0]!.revision_count, 1);

    // Second identical save → dedup bump, not a new row.
    await toolByName("lib_save").handler(saveArgs, db);
    out = parseResult(
      await toolByName("lib_criteria").handler({ persona: "arquitecto" }, db),
    ) as { criteria: Array<{ revision_count: number }> };
    assert.equal(out.criteria.length, 1, "no duplicate row");
    assert.equal(out.criteria[0]!.revision_count, 2, "revision_count bumped");
  });
});

describe("MCP tools — lib_bitacora_add / day / range", () => {
  const baseEntry = {
    project: "libreta",
    date: "2026-07-21",
    headline: "Shipped bitácora schema",
    summary: "Added table + tools; migration v2.",
    linked_ids: ["01OBSAAA", "01OBSBBB"],
  };

  it("lib_bitacora_add stores an entry and returns id + created_at", async () => {
    const db = newDb();
    const out = parseResult(await toolByName("lib_bitacora_add").handler(baseEntry, db)) as {
      id: string;
      created_at: string;
    };
    assert.match(out.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(out.created_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("lib_bitacora_add defaults linked_ids to [] when omitted", async () => {
    const db = newDb();
    const { linked_ids, ...noLinks } = baseEntry;
    void linked_ids;
    const out = parseResult(await toolByName("lib_bitacora_add").handler(noLinks, db)) as {
      id: string;
    };
    const day = parseResult(
      await toolByName("lib_bitacora_day").handler({ project: "libreta", date: "2026-07-21" }, db),
    ) as { entries: Array<{ id: string; linked_ids: string[] }> };
    const stored = day.entries.find((e) => e.id === out.id);
    assert.deepEqual(stored?.linked_ids, []);
  });

  it("lib_bitacora_day returns the day's entries", async () => {
    const db = newDb();
    await toolByName("lib_bitacora_add").handler({ ...baseEntry, headline: "a" }, db);
    await toolByName("lib_bitacora_add").handler({ ...baseEntry, date: "2026-07-20", headline: "b" }, db);
    const out = parseResult(
      await toolByName("lib_bitacora_day").handler({ project: "libreta", date: "2026-07-21" }, db),
    ) as { entries: Array<{ headline: string }> };
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0]!.headline, "a");
  });

  it("lib_bitacora_range returns entries within [from,to]", async () => {
    const db = newDb();
    for (const d of ["2026-07-18", "2026-07-21", "2026-07-25"]) {
      await toolByName("lib_bitacora_add").handler({ ...baseEntry, date: d, headline: d }, db);
    }
    const out = parseResult(
      await toolByName("lib_bitacora_range").handler(
        { project: "libreta", from: "2026-07-19", to: "2026-07-22" },
        db,
      ),
    ) as { entries: Array<{ date: string }> };
    assert.deepEqual(out.entries.map((e) => e.date), ["2026-07-21"]);
  });
});
