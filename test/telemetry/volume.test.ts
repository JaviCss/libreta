import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { LibretaDB } = await import("../../src/storage/libreta-db.js");

import type { TelemetryRow } from "../../src/telemetry/types.js";

let workDir: string;
const open: Array<{ close: () => void }> = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-telemetry-volume-"));
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
    session_id: "s1",
    agent_id: "a1",
    model: "claude-opus-5",
    agent: "coder",
    task_type: "apply",
    description: null,
    tool_use_id: null,
    spawn_depth: 1,
    duration_ms: null,
    turns: 1,
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
    thinking_method: "measured",
    tool_calls: 0,
    partial: 0,
    ingested_at: new Date().toISOString(),
    ...over,
  };
}

describe("telemetryVolume", () => {
  it("TM-4: two models on the same phase are comparable without further arithmetic", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ session_id: "s1", agent_id: "a1", model: "claude-opus-5", turns: 10, tool_calls: 35 }),
    ]);
    db.replaceSessionTelemetry("s2", [
      row({ session_id: "s2", agent_id: "a2", model: "claude-haiku-4-5", turns: 8, tool_calls: 4 }),
    ]);

    const groups = db.telemetryVolume("model", undefined, { task_type: "apply" });
    assert.deepEqual(
      groups.map((g) => g.key),
      ["claude-haiku-4-5", "claude-opus-5"],
    );
    const opus = groups.find((g) => g.key === "claude-opus-5");
    assert.ok(opus);
    assert.equal(opus.sessions, 1);
    assert.equal(opus.turns, 10);
    assert.equal(opus.tool_calls, 35);
    assert.equal(opus.tool_calls_per_turn, 3.5);
    const haiku = groups.find((g) => g.key === "claude-haiku-4-5");
    assert.ok(haiku);
    assert.equal(haiku.tool_calls_per_turn, 0.5);
  });

  it("TM-5: a group with a gapped count refuses the average and keeps the row", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ agent_id: "a1", turns: 4, tool_calls: 8 }),
      row({ agent_id: "a2", turns: 6, tool_calls: null }),
    ]);

    const [g] = db.telemetryVolume("model");
    assert.ok(g);
    assert.equal(g.rows, 2);
    assert.equal(g.turns, 10);
    assert.equal(g.gapped_rows, 1);
    assert.deepEqual(
      { kind: (g.tool_calls_per_turn as { kind: string }).kind, reason: (g.tool_calls_per_turn as { reason: string }).reason },
      { kind: "gap", reason: "tool-calls-not-counted" },
    );
    assert.equal((g.tool_calls as { kind: string }).kind, "gap");
  });

  it("refuses the average when the denominator is zero", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ turns: 0, tool_calls: 0 })]);
    const [g] = db.telemetryVolume("model");
    assert.ok(g);
    assert.equal((g.tool_calls_per_turn as { kind: string }).kind, "gap");
  });

  it("sums duration when no agent spans two models, and gaps it when one does", () => {
    const clean = freshDb();
    clean.replaceSessionTelemetry("s1", [
      row({ agent_id: "a1", duration_ms: 1000 }),
      row({ agent_id: "a2", duration_ms: 500 }),
    ]);
    const [g] = clean.telemetryVolume("model");
    assert.ok(g);
    assert.equal(g.duration_ms, 1500);

    const mixed = freshDb();
    mixed.replaceSessionTelemetry("s1", [
      row({ agent_id: "a1", model: "claude-opus-5", duration_ms: 1000 }),
      row({ agent_id: "a1", model: "claude-haiku-4-5", duration_ms: 1000 }),
    ]);
    for (const grp of mixed.telemetryVolume("model")) {
      assert.equal((grp.duration_ms as { kind: string }).kind, "gap");
      assert.equal((grp.duration_ms as { reason: string }).reason, "mixed-model-duration");
    }
  });

  it("keeps duration null when no row carries a timestamp, never zero", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ duration_ms: null })]);
    const [g] = db.telemetryVolume("model");
    assert.ok(g);
    assert.equal(g.duration_ms, null);
  });

  it("TM-6: a session under two models counts once per model", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ session_id: "s1", agent_id: "a1", model: "claude-opus-5" }),
      row({ session_id: "s1", agent_id: "a2", model: "claude-haiku-4-5" }),
    ]);
    const groups = db.telemetryVolume("model");
    assert.equal(groups.length, 2);
    for (const g of groups) assert.equal(g.sessions, 1);
  });

  it("crosses two allowed axes into one group key", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ agent_id: "a1", task_type: "apply", turns: 2, tool_calls: 2 }),
      row({ agent_id: "a2", task_type: "verify", turns: 2, tool_calls: 6 }),
    ]);
    const groups = db.telemetryVolume("model", "task_type");
    assert.deepEqual(
      groups.map((g) => g.key),
      ["claude-opus-5 × apply", "claude-opus-5 × verify"],
    );
    assert.deepEqual(groups[0]?.key_parts, ["claude-opus-5", "apply"]);
  });

  it("refuses an axis and a cross outside the allowed list", () => {
    const db = freshDb();
    assert.throws(() => db.telemetryVolume("nope" as never), /unsupported telemetry axis/);
    assert.throws(() => db.telemetryVolume("model", "cost" as never), /unsupported telemetry cross axis/);
  });
});
