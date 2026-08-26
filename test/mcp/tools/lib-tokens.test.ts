import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { LibretaDB } = await import("../../../src/storage/libreta-db.js");
const { ALL_TOOLS } = await import("../../../src/mcp/tools/index.js");
const { libTokensSeriesTool } = await import("../../../src/mcp/tools/lib-tokens-series.js");
const { libTokensReportTool } = await import("../../../src/mcp/tools/lib-tokens-report.js");

import type { TelemetryRow } from "../../../src/telemetry/types.js";

let workDir: string;
const open: Array<{ close: () => void }> = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-sp-tokens-"));
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

function seededDb(): InstanceType<typeof LibretaDB> {
  const db = new LibretaDB(join(workDir, `${randomUUID()}.db`));
  db.init();
  open.push(db);
  const base: TelemetryRow = {
    session_id: "s1",
    agent_id: "a1",
    model: "claude-opus-5",
    agent: "coder",
    task_type: "apply",
    description: "APPLY x",
    tool_use_id: null,
    spawn_depth: 1,
    duration_ms: null,
    turns: 2,
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
    thinking_method: "attributed",
    tool_calls: null,
    partial: 0,
    ingested_at: "2026-08-20T00:00:00.000Z",
  };
  db.replaceSessionTelemetry("s1", [
    base,
    { ...base, agent_id: "a2", agent: "revisor", task_type: "verify", output_tokens: 60 },
    { ...base, agent_id: "main", agent: "main", task_type: "none", output_tokens: 900 },
  ]);
  return db;
}

async function parseResult(result: { content: Array<{ text: string }> }): Promise<unknown> {
  return JSON.parse(result.content[0]!.text) as unknown;
}

describe("TT-10 — no lib_* tool can write a telemetry row", () => {
  it("registers exactly two telemetry tools and both are reads", () => {
    const telemetryTools = ALL_TOOLS.filter((t) => t.name.startsWith("lib_tokens"));
    assert.deepEqual(
      telemetryTools.map((t) => t.name).sort(),
      ["lib_tokens_report", "lib_tokens_series"],
    );
  });

  it("exposes no tool whose name suggests a telemetry write", () => {
    const writeish = ALL_TOOLS.filter((t) =>
      /token/i.test(t.name) && /(add|save|record|write|set|update|delete|ingest)/i.test(t.name),
    );
    assert.deepEqual(writeish, []);
  });

  it("leaves the series unchanged after every telemetry tool has run", async () => {
    const db = seededDb();
    const before = db.telemetryQuery({});

    await libTokensSeriesTool.handler({ session_id: "s1" }, db);
    await libTokensReportTool.handler({ axis: "agent" }, db);

    assert.deepEqual(db.telemetryQuery({}), before);
  });
});

describe("lib_tokens_series", () => {
  it("returns the rows for a session with the attribution label attached", async () => {
    const db = seededDb();
    const payload = (await parseResult(await libTokensSeriesTool.handler({ session_id: "s1" }, db))) as {
      rows: TelemetryRow[];
      attribution_note: string;
    };

    assert.equal(payload.rows.length, 3);
    assert.match(payload.attribution_note, /attributed/);
  });

  it("filters by agent and by task type", async () => {
    const db = seededDb();
    const byAgent = (await parseResult(await libTokensSeriesTool.handler({ agent: "revisor" }, db))) as {
      rows: TelemetryRow[];
    };
    const byTask = (await parseResult(await libTokensSeriesTool.handler({ task_type: "apply" }, db))) as {
      rows: TelemetryRow[];
    };

    assert.equal(byAgent.rows.length, 1);
    assert.equal(byTask.rows.length, 1);
  });

  it("caps the number of rows it returns", async () => {
    const db = seededDb();
    const payload = (await parseResult(await libTokensSeriesTool.handler({ limit: 1 }, db))) as {
      rows: TelemetryRow[];
      truncated: boolean;
    };
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.truncated, true);
  });
});

describe("lib_tokens_report", () => {
  it("groups by an axis and publishes the main remainder apart — TT-12", async () => {
    const db = seededDb();
    const payload = (await parseResult(await libTokensReportTool.handler({ axis: "task_type" }, db))) as {
      groups: Array<{ key: string }>;
      unattributed_main: { output_tokens: number };
    };

    assert.deepEqual(payload.groups.map((g) => g.key).sort(), ["apply", "verify"]);
    assert.equal(payload.unattributed_main.output_tokens, 900);
  });

  it("refuses an axis outside the allowed set", async () => {
    const db = seededDb();
    await assert.rejects(() => libTokensReportTool.handler({ axis: "description" }, db), /axis/i);
  });

  it("never states a cost, because prices are a CLI-time input", async () => {
    const db = seededDb();
    const payload = (await parseResult(await libTokensReportTool.handler({ axis: "agent" }, db))) as {
      groups: Array<{ cost_usd: number | null }>;
      price_source: string | null;
    };
    assert.equal(payload.price_source, null);
    assert.equal(payload.groups.every((g) => g.cost_usd === null), true);
  });
});
