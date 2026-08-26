import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { LibretaDB } = await import("../../src/storage/libreta-db.js");
const { loadPriceTable, costOf } = await import("../../src/telemetry/prices.js");
const { buildReport, compareReport, MEASURED_NOTE, ATTRIBUTED_BLOCK_NOTE } = await import(
  "../../src/telemetry/report.js"
);

import type { TelemetryRow } from "../../src/telemetry/types.js";

let workDir: string;
const open: Array<{ close: () => void }> = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-telemetry-report-"));
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
    description: "APPLY x",
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
    tool_calls: null,
    partial: 0,
    ingested_at: "2026-08-20T00:00:00.000Z",
    ...over,
  };
}

const PRICES = {
  source: "documentation/research/2026-08-19-costo-api-del-gate.md §1",
  date: "2026-08-19",
  currency: "USD",
  perMTok: {
    "claude-opus-5": { input: 5, output: 25, cache_creation: 6.25, cache_read: 0.5 },
  },
};

async function pricesFile(payload: unknown = PRICES): Promise<string> {
  const path = join(workDir, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(payload), "utf8");
  return path;
}

describe("loadPriceTable — TT-11", () => {
  it("loads a table that names its source and date", async () => {
    const table = await loadPriceTable(await pricesFile());
    assert.equal(table.source, PRICES.source);
    assert.equal(table.date, "2026-08-19");
  });

  it("refuses a table without a source", async () => {
    const path = await pricesFile({ date: "2026-08-19", perMTok: {} });
    await assert.rejects(() => loadPriceTable(path), /source/);
  });

  it("refuses a table without a date", async () => {
    const path = await pricesFile({ source: "x", perMTok: {} });
    await assert.rejects(() => loadPriceTable(path), /date/);
  });

  it("refuses a table with no model prices", async () => {
    const path = await pricesFile({ source: "x", date: "2026-08-19", perMTok: {} });
    await assert.rejects(() => loadPriceTable(path), /perMTok/);
  });
});

describe("costOf", () => {
  it("prices the four components per million tokens", async () => {
    const table = await loadPriceTable(await pricesFile());
    const cost = costOf(
      { input: 1_000_000, output: 1_000_000, cache_creation: 1_000_000, cache_read: 1_000_000 },
      "claude-opus-5",
      table,
    );
    assert.equal(cost, 5 + 25 + 6.25 + 0.5);
  });

  it("returns null for a model the table does not price, instead of guessing", async () => {
    const table = await loadPriceTable(await pricesFile());
    assert.equal(costOf({ input: 1, output: 1, cache_creation: 0, cache_read: 0 }, "gpt-x", table), null);
  });
});

describe("buildReport — TT-12 the main remainder is published, not spread", () => {
  it("keeps the main total out of the task rows and publishes it as unattributed", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ agent: "coder", task_type: "apply", output_tokens: 100 }),
      row({ agent_id: "a2", agent: "revisor", task_type: "verify", output_tokens: 60 }),
      row({ agent_id: "main", agent: "main", task_type: "none", output_tokens: 900, description: null }),
    ]);

    const report = buildReport(db, { axis: "task_type" });

    assert.deepEqual(
      report.groups.map((g) => g.key).sort(),
      ["apply", "verify"],
    );
    assert.equal(report.groups.some((g) => g.key === "none"), false);
    assert.equal(report.unattributedMain.output_tokens, 900);
    assert.equal(
      report.groups.reduce((a, g) => a + g.output_tokens, 0),
      160,
    );
  });

  it("groups by agent and by model too", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ agent: "coder", output_tokens: 10 }),
      row({ agent_id: "a2", agent: "coder", model: "claude-haiku-4", output_tokens: 5 }),
    ]);

    assert.deepEqual(buildReport(db, { axis: "agent" }).groups.map((g) => g.key), ["coder"]);
    assert.deepEqual(
      buildReport(db, { axis: "model" }).groups.map((g) => g.key),
      ["claude-haiku-4", "claude-opus-5"],
    );
  });

  it("separates work from cache on the criterion sealed by statusline", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ input_tokens: 10, output_tokens: 100, cache_creation_tokens: 1000, cache_read_tokens: 50000 }),
    ]);

    const g = buildReport(db, { axis: "agent" }).groups[0]!;
    assert.equal(g.work, 1110);
    assert.equal(g.cache, 50000);
    assert.equal(g.total, 51110);
  });

  it("labels the attribution and never mixes it with the measured components", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ thinking_method: "attributed", out_code: 5, output_tokens: 5 })]);

    const report = buildReport(db, { axis: "agent" });
    assert.equal(report.attributionNote.includes("attributed"), true);
    assert.equal(report.groups[0]!.attributed, true);
  });

  it("states no cost at all when no price table was supplied", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ output_tokens: 10 })]);

    const report = buildReport(db, { axis: "agent" });
    assert.equal(report.priceSource, null);
    assert.equal(report.groups[0]!.cost_usd, null);
  });

  it("names the price source and date whenever it states a cost — TT-11", async () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ output_tokens: 1_000_000 })]);
    const prices = await loadPriceTable(await pricesFile());

    const report = buildReport(db, { axis: "agent", prices });

    assert.equal(report.groups[0]!.cost_usd, 25);
    assert.equal(report.priceSource, PRICES.source);
    assert.equal(report.priceDate, "2026-08-19");
  });

  it("declares an unpriced model instead of costing it as zero", async () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ model: "gpt-x", output_tokens: 1000 })]);
    const prices = await loadPriceTable(await pricesFile());

    const report = buildReport(db, { axis: "model", prices });

    assert.equal(report.groups[0]!.cost_usd, null);
    assert.deepEqual(report.unpricedModels, ["gpt-x"]);
  });

  it("a price change does not rewrite the stored rows", async () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ output_tokens: 1_000_000 })]);
    const cheap = await loadPriceTable(
      await pricesFile({
        ...PRICES,
        date: "2026-09-01",
        perMTok: { "claude-opus-5": { input: 1, output: 1, cache_creation: 1, cache_read: 1 } },
      }),
    );

    const report = buildReport(db, { axis: "agent", prices: cheap });

    assert.equal(report.groups[0]!.cost_usd, 1);
    assert.equal(db.telemetryQuery({ session_id: "s1" })[0]!.output_tokens, 1_000_000);
  });
});

describe("buildReport — TM-7/TM-8/TM-9 measured and attributed are separate blocks", () => {
  it("TM-7 puts the four billed components in the measured block and no attributed number with them", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({
        input_tokens: 7,
        output_tokens: 100,
        cache_creation_tokens: 11,
        cache_read_tokens: 13,
        out_thinking: 40,
        out_prose: 20,
        out_tool_call: 15,
        out_code: 15,
        out_test: 5,
        out_doc: 5,
      }),
    ]);

    const report = buildReport(db, { axis: "model" });
    const g = report.groups[0]!;

    assert.equal(g.blocks.measured.method, "measured");
    assert.deepEqual(g.blocks.measured.components, {
      input_tokens: 7,
      output_tokens: 100,
      cache_creation_tokens: 11,
      cache_read_tokens: 13,
    });
    assert.deepEqual(Object.keys(g.blocks.measured.classes).sort(), ["thinking"]);
    assert.equal(g.blocks.attributed.method, "attributed");
    assert.deepEqual(
      Object.keys(g.blocks.attributed.classes).sort(),
      ["code", "doc", "prose", "test", "tool_call"],
    );
    assert.match(report.formatNotes.measured, /reporta el proveedor/);
    assert.doesNotMatch(report.formatNotes.measured, /bytes|aproximaci[óo]n/i);
    assert.match(report.formatNotes.attributed, /bytes/i);
    assert.doesNotMatch(report.formatNotes.attributed, /reporta el proveedor/i);
  });

  it("TM-8 thinking sits in the block its own method names, with the reason when attributed", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ model: "metered-model", thinking_method: "measured", output_tokens: 10, out_thinking: 10 }),
      row({
        agent_id: "a2",
        model: "unmetered-model",
        thinking_method: "attributed",
        output_tokens: 10,
        out_thinking: 10,
      }),
    ]);

    const byKey = new Map(buildReport(db, { axis: "model" }).groups.map((g) => [g.key, g]));
    const metered = byKey.get("metered-model")!;
    const unmetered = byKey.get("unmetered-model")!;

    assert.equal(metered.blocks.measured.classes.thinking, 10);
    assert.equal(metered.blocks.attributed.classes.thinking, undefined);
    assert.equal(metered.blocks.attributed.thinking_reason, null);

    assert.equal(unmetered.blocks.attributed.classes.thinking, 10);
    assert.equal(unmetered.blocks.measured.classes.thinking, undefined);
    assert.match(String(unmetered.blocks.attributed.thinking_reason), /thinking_tokens/);
    assert.match(String(unmetered.blocks.attributed.thinking_reason), /bytes/);
  });

  it("TM-9 the six classes across both blocks still sum output_tokens", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ output_tokens: 100, out_thinking: 40, out_prose: 20, out_tool_call: 15, out_code: 15, out_test: 5, out_doc: 5 }),
      row({
        agent_id: "a2",
        thinking_method: "attributed",
        output_tokens: 50,
        out_thinking: 10,
        out_prose: 10,
        out_tool_call: 10,
        out_code: 10,
        out_test: 5,
        out_doc: 5,
      }),
    ]);

    for (const g of buildReport(db, { axis: "model" }).groups) {
      const all = { ...g.blocks.measured.classes, ...g.blocks.attributed.classes };
      const sum = Object.values(all).reduce((a, n) => a + n, 0);
      assert.equal(sum, g.output_tokens);
      assert.equal(Object.keys(all).length, 6);
    }
  });

  it("keeps every flat field where it was: blocks is additive", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ output_tokens: 100, out_prose: 100 })]);

    const g = buildReport(db, { axis: "agent" }).groups[0]!;

    assert.equal(g.out_prose, 100);
    assert.equal(g.output_tokens, 100);
    assert.equal(g.work, 100);
    assert.equal(g.total, 100);
    assert.equal(g.attributed, false);
  });

  it("TM-14 building the report writes nothing and changes no stored value", async () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ output_tokens: 100, out_prose: 100 })]);
    const before = db.telemetryQuery({ session_id: "s1" });
    const filesBefore = (await readdir(workDir)).sort();

    buildReport(db, { axis: "model" });

    assert.deepEqual(db.telemetryQuery({ session_id: "s1" }), before);
    assert.deepEqual((await readdir(workDir)).sort(), filesBefore);
  });
});

describe("buildReport — TH-11/TH-12 the method note is stated once, classes stay in order", () => {
  it("TH-11 the method notes appear once at report level, and each group's blocks carry no note", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ model: "m1", output_tokens: 10 }),
      row({ agent_id: "a2", model: "m2", output_tokens: 10 }),
      row({ agent_id: "a3", model: "m3", output_tokens: 10 }),
    ]);

    const report = buildReport(db, { axis: "model" });

    assert.equal(report.formatNotes.measured, MEASURED_NOTE);
    assert.equal(report.formatNotes.attributed, ATTRIBUTED_BLOCK_NOTE);
    assert.equal(report.groups.length, 3);
    for (const g of report.groups) {
      assert.equal("note" in g.blocks.measured, false);
      assert.equal("note" in g.blocks.attributed, false);
    }
  });

  it("TH-12 the six classes land in the same fixed key order for every group", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ model: "m1", output_tokens: 100, out_thinking: 10, out_prose: 90, thinking_method: "measured" }),
      row({
        agent_id: "a2",
        model: "m2",
        output_tokens: 100,
        out_thinking: 10,
        out_prose: 90,
        thinking_method: "attributed",
      }),
    ]);

    const report = buildReport(db, { axis: "model" });
    for (const g of report.groups) {
      const all = { ...g.blocks.measured.classes, ...g.blocks.attributed.classes };
      assert.deepEqual(Object.keys(all), ["thinking", "prose", "tool_call", "code", "test", "doc"]);
    }
  });
});

describe("compareReport — TH-9/TH-10 comparing two points in time", () => {
  it("TH-9 compares two snapshots by model, side by side, with thinking's method labelled on each side", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [
      row({ model: "m1", output_tokens: 100, thinking_method: "measured", out_thinking: 10 }),
    ]);
    db.replaceSessionTelemetry("s1", [
      row({ model: "m1", output_tokens: 200, thinking_method: "attributed", out_thinking: 20 }),
    ]);
    const first = db.latestSnapshotForSession("s1")!;
    db.replaceSessionTelemetry("s1", [row({ model: "m1", output_tokens: 300 })]);
    const second = db.latestSnapshotForSession("s1")!;

    const cmp = compareReport(db, { axis: "model", snapshotId: first.id, against: second.id });

    assert.equal(cmp.left.source, "snapshot");
    assert.equal(cmp.right.source, "snapshot");
    const leftM1 = cmp.left.groups.find((g) => g.key === "m1")!;
    const rightM1 = cmp.right.groups.find((g) => g.key === "m1")!;
    assert.equal(leftM1.components.output_tokens, 100);
    assert.equal(rightM1.components.output_tokens, 200);
    assert.equal(leftM1.thinkingLabel, "measured");
    assert.equal(rightM1.thinkingLabel, "attributed");
  });

  it("TH-10 compares a snapshot against the current live series", () => {
    const db = freshDb();
    db.replaceSessionTelemetry("s1", [row({ model: "m1", output_tokens: 100 })]);
    db.replaceSessionTelemetry("s1", [row({ model: "m1", output_tokens: 500 })]);
    const snap = db.latestSnapshotForSession("s1")!;

    const cmp = compareReport(db, { axis: "model", snapshotId: snap.id, against: "live" });

    assert.equal(cmp.left.source, "snapshot");
    assert.equal(cmp.right.source, "live");
    assert.equal(cmp.left.groups.find((g) => g.key === "m1")!.components.output_tokens, 100);
    assert.equal(cmp.right.groups.find((g) => g.key === "m1")!.components.output_tokens, 500);
  });
});
