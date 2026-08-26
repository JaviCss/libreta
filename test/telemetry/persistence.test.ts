import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { LibretaDB, MIGRATIONS, LATEST_SCHEMA_VERSION } = await import(
  "../../src/storage/libreta-db.js"
);
const { taskTypeOf, DEFAULT_TASK_TYPE_PREFIXES } = await import("../../src/telemetry/task-type.js");

import type { TelemetryRow } from "../../src/telemetry/types.js";

let workDir: string;
const open: Array<{ close: () => void }> = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-telemetry-db-"));
});

beforeEach(() => {
  for (const h of open.splice(0)) {
    try {
      h.close();
    } catch {
      /* ignore */
    }
  }
});

after(async () => {
  for (const h of open.splice(0)) {
    try {
      h.close();
    } catch {
      /* ignore */
    }
  }
  await rm(workDir, { recursive: true, force: true });
});

function freshDb(): InstanceType<typeof LibretaDB> {
  const db = new LibretaDB(join(workDir, `${randomUUID()}.db`));
  db.init();
  open.push(db);
  return db;
}

function row(over: Partial<TelemetryRow> = {}): TelemetryRow {
  return {
    session_id: "sess-1",
    agent_id: "a1",
    model: "claude-opus-5",
    agent: "coder",
    task_type: "apply",
    description: "APPLY foo",
    tool_use_id: "toolu_1",
    spawn_depth: 1,
    duration_ms: null,
    turns: 3,
    input_tokens: 10,
    output_tokens: 100,
    cache_creation_tokens: 1000,
    cache_read_tokens: 50000,
    out_thinking: 10,
    out_prose: 20,
    out_tool_call: 30,
    out_code: 40,
    out_test: 0,
    out_doc: 0,
    thinking_method: "measured",
    tool_calls: null,
    partial: 0,
    ingested_at: "2026-08-20T00:00:00.000Z",
    ...over,
  };
}

describe("task type map — TT-5", () => {
  it("maps a declared prefix to its task type", () => {
    assert.equal(taskTypeOf("APPLY install-limpia-huerfanos"), "apply");
    assert.equal(taskTypeOf("VERIFY gate-un-solo-agente"), "verify");
    assert.equal(taskTypeOf("REFUTE ledger sellado"), "refute");
  });

  it("is case-insensitive on the prefix", () => {
    assert.equal(taskTypeOf("apply algo"), "apply");
  });

  it("falls back to other when nothing matches, so the row is never dropped", () => {
    assert.equal(taskTypeOf("Docs dormant 14b-14d"), "other");
    assert.equal(taskTypeOf(null), "other");
  });

  it("honours a caller-supplied prefix map", () => {
    assert.equal(taskTypeOf("HOTFIX x", { HOTFIX: "hotfix" }), "hotfix");
    assert.ok(Object.keys(DEFAULT_TASK_TYPE_PREFIXES).includes("APPLY"));
  });
});

describe("migration — TT-9", () => {
  it("registers the telemetry migration in the forward-only registry", () => {
    assert.equal(LATEST_SCHEMA_VERSION, MIGRATIONS.length);
    assert.equal(MIGRATIONS.find((m) => m.name === "add-agent-token-usage")!.version, 6);
  });

  it("creates the table without disturbing observations or bitácora", () => {
    const db = freshDb();
    const obs = db.save({
      project: "p",
      title: "t",
      type: "decision",
      what: "w",
      why: "y",
      where: "wh",
      learned: "l",
    });
    const entry = db.addBitacora({
      project: "p",
      date: "2026-08-20",
      headline: "h",
      summary: "s",
      linked_ids: [],
    });

    db.replaceSessionTelemetry("sess-1", [row()]);

    assert.equal(db.getById(obs.id)!.title, "t");
    assert.equal(db.bitacoraDay("p", "2026-08-20")[0]!.id, entry.id);
    assert.equal(db.telemetryQuery({ session_id: "sess-1" }).length, 1);
  });
});

describe("replaceSessionTelemetry — TT-8 idempotence", () => {
  it("re-ingesting a session replaces its rows instead of doubling them", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row(), row({ agent_id: "a2" })]);
    db.replaceSessionTelemetry("sess-1", [row(), row({ agent_id: "a2" })]);

    const rows = db.telemetryQuery({ session_id: "sess-1" });
    assert.equal(rows.length, 2);
    assert.equal(
      rows.reduce((a, r) => a + r.output_tokens, 0),
      200,
    );
  });

  it("leaves other sessions untouched", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row()]);
    db.replaceSessionTelemetry("sess-2", [row({ session_id: "sess-2" })]);
    db.replaceSessionTelemetry("sess-1", [row()]);

    assert.equal(db.telemetryQuery({ session_id: "sess-2" }).length, 1);
    assert.equal(db.telemetryQuery({}).length, 2);
  });

  it("keeps one row per (session_id, agent_id, model)", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row(), row({ model: "claude-haiku-4" })]);

    const rows = db.telemetryQuery({ session_id: "sess-1" });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.model).sort(), ["claude-haiku-4", "claude-opus-5"]);
  });

  it("stores cache_read apart from work — TT-2", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ cache_read_tokens: 3570220, output_tokens: 18082 })]);

    const stored = db.telemetryQuery({ session_id: "sess-1" })[0]!;
    assert.equal(stored.cache_read_tokens, 3570220);
    assert.equal(stored.output_tokens, 18082);
  });

  it("stores the raw description verbatim next to the derived task type — TT-5", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [
      row({ description: "Docs dormant 14b-14d", task_type: "other" }),
    ]);

    const stored = db.telemetryQuery({ session_id: "sess-1" })[0]!;
    assert.equal(stored.description, "Docs dormant 14b-14d");
    assert.equal(stored.task_type, "other");
  });

  it("round-trips duration_ms, including the null of a transcript without timestamps", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [
      row({ duration_ms: 493000 }),
      row({ agent_id: "a2", duration_ms: null }),
    ]);

    const rows = db.telemetryQuery({ session_id: "sess-1" });
    assert.deepEqual(
      rows.map((r) => r.duration_ms).sort((a, b) => (a ?? -1) - (b ?? -1)),
      [null, 493000],
    );
  });

  it("stores the main-thread row with agent main and no task — TT-12", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [
      row({ agent: "main", agent_id: "main", task_type: "none", description: null, tool_use_id: null }),
    ]);

    const stored = db.telemetryQuery({ agent: "main" })[0]!;
    assert.equal(stored.agent, "main");
    assert.equal(stored.description, null);
  });
});

describe("tool_calls persistence — TM-3", () => {
  it("re-ingesting a session already stored without the counter fills it without doubling the totals", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ tool_calls: null })]);
    const before = db.telemetryQuery({ session_id: "sess-1" });
    assert.equal(before.length, 1);
    assert.equal(before[0]!.tool_calls, null);

    db.replaceSessionTelemetry("sess-1", [row({ tool_calls: 7 })]);

    const after = db.telemetryQuery({ session_id: "sess-1" });
    assert.equal(after.length, 1);
    assert.equal(after[0]!.tool_calls, 7);
    assert.equal(after[0]!.output_tokens, before[0]!.output_tokens);
    assert.equal(after[0]!.out_tool_call, before[0]!.out_tool_call);
  });

  it("round-trips a real 0 apart from the NULL gap", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-z", [
      row({ session_id: "sess-z", tool_calls: 0 }),
      row({ session_id: "sess-z", agent_id: "a2", tool_calls: null }),
    ]);

    const rows = db.telemetryQuery({ session_id: "sess-z" });
    assert.equal(rows.find((r) => r.agent_id === "a1")!.tool_calls, 0);
    assert.equal(rows.find((r) => r.agent_id === "a2")!.tool_calls, null);
  });
});

describe("telemetryQuery filters", () => {
  it("filters by agent, task type and ingest date range", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [
      row({ agent: "coder", task_type: "apply", ingested_at: "2026-08-01T00:00:00.000Z" }),
      row({ agent_id: "a2", agent: "revisor", task_type: "verify", ingested_at: "2026-08-10T00:00:00.000Z" }),
    ]);

    assert.equal(db.telemetryQuery({ agent: "revisor" }).length, 1);
    assert.equal(db.telemetryQuery({ task_type: "apply" }).length, 1);
    assert.equal(db.telemetryQuery({ from: "2026-08-05", to: "2026-08-20" }).length, 1);
  });
});

describe("pre-replace snapshot capture — TH-1..TH-4", () => {
  it("TH-3: first-time ingest of a session writes no snapshot", () => {
    const db = freshDb();
    const { snapshotGap } = db.replaceSessionTelemetry("sess-1", [row()]);

    assert.equal(snapshotGap, null);
    assert.equal(db.latestSnapshotForSession("sess-1"), null);
  });

  it("TH-2: re-ingest photographs what it is about to erase, totals reconcile", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [
      row({ output_tokens: 100, input_tokens: 10 }),
      row({ agent_id: "a2", output_tokens: 50, input_tokens: 5 }),
    ]);

    const { snapshotGap } = db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 999 })]);

    assert.equal(snapshotGap, null);
    const snapshot = db.latestSnapshotForSession("sess-1");
    assert.ok(snapshot);
    assert.equal(snapshot!.reason, "pre-replace");
    assert.equal(snapshot!.session_id, "sess-1");

    const totals = db.telemetrySnapshotTotals(snapshot!.id);
    const total = totals.find((t) => t.axis === "total")!;
    assert.equal(total.output_tokens, 150);
    assert.equal(total.input_tokens, 15);

    const stored = db.telemetryQuery({ session_id: "sess-1" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.output_tokens, 999);
  });

  it("TH-4: a snapshot capture failure does not block the replace and surfaces as a gap", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row()]);
    (db as unknown as { captureSnapshot: () => void }).captureSnapshot = () => {
      throw new Error("disk full");
    };

    const { snapshotGap } = db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 321 })]);

    assert.ok(snapshotGap);
    assert.equal(snapshotGap!.reason, "snapshot-capture-failed");
    assert.match(snapshotGap!.detail ?? "", /disk full/);

    const stored = db.telemetryQuery({ session_id: "sess-1" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.output_tokens, 321);
  });

  it("TH-4: a capture that fails midway leaves no snapshot header behind, and the replace still lands", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);

    const inner = (db as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const realPrepare = inner.prepare.bind(inner);
    inner.prepare = (sql: string) => {
      if (sql.includes("INSERT INTO telemetry_snapshot_total")) {
        return {
          run: () => {
            throw new Error("disk full");
          },
        };
      }
      return realPrepare(sql);
    };

    const { snapshotGap } = db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 321 })]);
    inner.prepare = realPrepare;

    assert.ok(snapshotGap);
    assert.equal(snapshotGap!.reason, "snapshot-capture-failed");
    assert.equal(db.latestSnapshotForSession("sess-1"), null);

    const stored = db.telemetryQuery({ session_id: "sess-1" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.output_tokens, 321);
  });

  it("TH-1: a later ingest, report or note does not change an earlier snapshot's rows", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 200 })]);
    const firstSnapshot = db.latestSnapshotForSession("sess-1")!;
    const firstTotals = db.telemetrySnapshotTotals(firstSnapshot.id);

    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 300 })]);

    const stillThere = db.telemetrySnapshotTotals(firstSnapshot.id);
    assert.deepEqual(stillThere, firstTotals);
  });

  it("TH-2b: a re-ingest whose erased aggregate is byte-identical to the last snapshot does not duplicate it", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100, input_tokens: 10 })]);
    // Live rows are still output_tokens:100 here, so this replace photographs
    // that unchanged 100 as the first (and, after dedup, only) snapshot.
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100, input_tokens: 10 })]);
    const firstSnapshot = db.latestSnapshotForSession("sess-1")!;

    const { snapshotGap } = db.replaceSessionTelemetry("sess-1", [
      row({ output_tokens: 100, input_tokens: 10 }),
    ]);

    assert.equal(snapshotGap, null);
    const latest = db.latestSnapshotForSession("sess-1")!;
    assert.equal(latest.id, firstSnapshot.id);
  });

  it("TH-2b does not delete or rewrite the earlier snapshot it dedups against", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);
    const firstSnapshot = db.latestSnapshotForSession("sess-1")!;
    const firstTotals = db.telemetrySnapshotTotals(firstSnapshot.id);

    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);

    assert.deepEqual(db.telemetrySnapshotTotals(firstSnapshot.id), firstTotals);
  });
});

describe("output-class snapshot — TH-5..TH-6", () => {
  it("TH-5: per-axis totals reconcile back to the total axis", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [
      row({ agent: "coder", model: "claude-opus-5", output_tokens: 100 }),
      row({ agent_id: "a2", agent: "revisor", model: "claude-haiku-4", output_tokens: 50 }),
    ]);
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 999 })]);

    const snapshot = db.latestSnapshotForSession("sess-1")!;
    const totals = db.telemetrySnapshotTotals(snapshot.id);
    const total = totals.find((t) => t.axis === "total")!;
    const byAgent = totals.filter((t) => t.axis === "agent");
    const byModel = totals.filter((t) => t.axis === "model");

    assert.equal(
      byAgent.reduce((a, t) => a + t.output_tokens, 0),
      total.output_tokens,
    );
    assert.equal(
      byModel.reduce((a, t) => a + t.output_tokens, 0),
      total.output_tokens,
    );
  });

  it("TH-6: measured_share is the exact ratio, and no byte-share class carries a manufactured precision figure", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [
      row({ output_tokens: 100, thinking_method: "measured" }),
      row({ agent_id: "a2", output_tokens: 300, thinking_method: "attributed" }),
    ]);
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 999 })]);

    const snapshot = db.latestSnapshotForSession("sess-1")!;
    const classes = db.telemetrySnapshotOutputClasses(snapshot.id);
    const totalClasses = classes.filter((c) => c.axis === "total");

    for (const c of totalClasses) {
      assert.equal(c.measured_share, 100 / 400);
    }
    assert.equal(new Set(totalClasses.map((c) => c.class)).size, 6);
  });
});

describe("snapshot notes — TH-7", () => {
  it("TH-7: a note added later leaves the snapshot's totals and output-class rows untouched", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 200 })]);
    const snapshot = db.latestSnapshotForSession("sess-1")!;
    const totalsBefore = db.telemetrySnapshotTotals(snapshot.id);
    const classesBefore = db.telemetrySnapshotOutputClasses(snapshot.id);

    db.addSnapshotNote(snapshot.id, "revisado 90 días después", "javier");

    assert.deepEqual(db.telemetrySnapshotTotals(snapshot.id), totalsBefore);
    assert.deepEqual(db.telemetrySnapshotOutputClasses(snapshot.id), classesBefore);
    const notes = db.snapshotNotes(snapshot.id);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.text, "revisado 90 días después");
    assert.equal(notes[0]!.author, "javier");
  });

  it("accepts multiple notes with a nullable author", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 200 })]);
    const snapshot = db.latestSnapshotForSession("sess-1")!;

    db.addSnapshotNote(snapshot.id, "nota del agente");
    db.addSnapshotNote(snapshot.id, "nota de javier", "javier");

    const notes = db.snapshotNotes(snapshot.id);
    assert.equal(notes.length, 2);
    assert.equal(notes[0]!.author, null);
    assert.equal(notes[1]!.author, "javier");
  });

  it("returns notes in insertion order even when several land in the same millisecond", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 200 })]);
    const snapshot = db.latestSnapshotForSession("sess-1")!;

    const inserted: string[] = [];
    for (let i = 0; i < 20; i++) {
      const text = `nota-${i}`;
      db.addSnapshotNote(snapshot.id, text);
      inserted.push(text);
    }

    const notes = db.snapshotNotes(snapshot.id);
    assert.deepEqual(
      notes.map((n) => n.text),
      inserted,
    );
  });
});

describe("snapshot reason — TH-8", () => {
  it("TH-8: an automatic pre-replace snapshot and a manual one are distinguishable", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 100 })]);
    db.replaceSessionTelemetry("sess-1", [row({ output_tokens: 200 })]);
    const auto = db.latestSnapshotForSession("sess-1")!;

    (
      db as unknown as {
        db: { prepare: (sql: string) => { run: (params: Record<string, unknown>) => void } };
      }
    ).db
      .prepare(
        `INSERT INTO telemetry_snapshot (id, taken_at, reason, session_id, schema_version)
         VALUES (@id, @taken_at, @reason, @session_id, @schema_version)`,
      )
      .run({
        id: "manual-1",
        taken_at: "2026-08-24T00:00:00.000Z",
        reason: "manual",
        session_id: null,
        schema_version: 8,
      });

    assert.equal(auto.reason, "pre-replace");
    assert.notEqual(auto.reason, "manual");
  });
});

describe("telemetryAggregate", () => {
  it("groups totals by an allowed axis", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("sess-1", [
      row({ agent: "coder", output_tokens: 100 }),
      row({ agent_id: "a2", agent: "coder", output_tokens: 50 }),
      row({ agent_id: "a3", agent: "revisor", output_tokens: 25 }),
    ]);

    const byAgent = db.telemetryAggregate("agent", {});
    assert.deepEqual(
      byAgent.map((g) => [g.key, g.output_tokens]),
      [
        ["coder", 150],
        ["revisor", 25],
      ],
    );
  });

  it("refuses an axis that is not an allowed column", () => {
    const db = freshDb();
    assert.throws(() => db.telemetryAggregate("output_tokens; DROP TABLE" as never, {}), /axis/i);
  });
});
