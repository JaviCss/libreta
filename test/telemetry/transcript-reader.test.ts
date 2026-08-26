import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseTurns, sumTurns, readDelegation, readSession, parseDailyBilled } = await import(
  "../../src/telemetry/transcript-reader.js"
);

let workDir: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-telemetry-reader-"));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function assistantLine(
  messageId: string,
  usage: Record<string, unknown>,
  content: unknown[],
  model = "claude-opus-5",
): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: true,
    message: { id: messageId, model, content, usage },
  });
}

function usage(
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number,
  thinking?: number,
): Record<string, unknown> {
  const u: Record<string, unknown> = {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
  if (thinking !== undefined) u["output_tokens_details"] = { thinking_tokens: thinking };
  return u;
}

async function writeDelegation(
  dir: string,
  agentId: string,
  lines: string[],
  meta: Record<string, unknown> | null,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const jsonl = join(dir, `agent-${agentId}.jsonl`);
  await writeFile(jsonl, lines.join("\n") + "\n", "utf8");
  if (meta) await writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta), "utf8");
  return jsonl;
}

describe("parseTurns — one turn is one message id, not one JSONL line", () => {
  it("collapses the streamed lines of one message id and keeps the last usage", () => {
    const content = [
      assistantLine("msg_a", usage(2, 4, 100, 0), [{ type: "thinking", thinking: "hm" }]),
      assistantLine("msg_a", usage(2, 500, 100, 0), [{ type: "text", text: "done" }]),
    ].join("\n");

    const { turns, corruptLines } = parseTurns(content);

    assert.equal(corruptLines, 0);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.usage.output, 500);
    assert.equal(turns[0]!.usage.cacheCreation, 100);
    assert.deepEqual(
      turns[0]!.blocks.map((b) => b.type),
      ["thinking", "text"],
    );
  });

  it("summing per line would double-count, so the totals use one usage per message id", () => {
    const content = [
      assistantLine("msg_a", usage(2, 4, 1000, 5000), [{ type: "text", text: "a" }]),
      assistantLine("msg_a", usage(2, 400, 1000, 5000), [{ type: "text", text: "b" }]),
      assistantLine("msg_b", usage(2, 100, 700, 6000), [{ type: "text", text: "c" }]),
    ].join("\n");

    const totals = sumTurns(parseTurns(content).turns);

    assert.deepEqual(totals, {
      input: 4,
      output: 500,
      cacheCreation: 1700,
      cacheRead: 11000,
      thinkingMeasured: null,
    });
  });

  it("parses CRLF transcripts", () => {
    const content = [
      assistantLine("msg_a", usage(1, 2, 3, 4), [{ type: "text", text: "a" }]),
      assistantLine("msg_b", usage(1, 2, 3, 4), [{ type: "text", text: "b" }]),
    ].join("\r\n");

    assert.equal(parseTurns(content).turns.length, 2);
  });

  it("skips a truncated last line instead of aborting the rest", () => {
    const content =
      [
        assistantLine("msg_a", usage(1, 10, 0, 0), [{ type: "text", text: "a" }]),
        assistantLine("msg_b", usage(1, 20, 0, 0), [{ type: "text", text: "b" }]),
      ].join("\n") + '\n{"type":"assistant","message":{"id":"msg_c"';

    const { turns, corruptLines } = parseTurns(content);

    assert.equal(turns.length, 2);
    assert.equal(corruptLines, 1);
  });

  it("carries the measured thinking tokens when the provider reports them", () => {
    const content = assistantLine("msg_a", usage(1, 200, 0, 0, 15), [
      { type: "thinking", thinking: "x" },
    ]);

    assert.equal(parseTurns(content).turns[0]!.usage.thinkingMeasured, 15);
  });

  it("ignores user lines and assistant lines without usage", () => {
    const content = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { id: "msg_x", content: [] } }),
      assistantLine("msg_a", usage(1, 10, 0, 0), [{ type: "text", text: "a" }]),
    ].join("\n");

    assert.equal(parseTurns(content).turns.length, 1);
  });
});

describe("readDelegation — TT-1, TT-2, TT-6, TT-7", () => {
  it("sums every turn of a multi-turn delegation and keeps the four components apart", async () => {
    const dir = join(workDir, "s1", "subagents");
    const jsonl = await writeDelegation(
      dir,
      "aaa1",
      [
        assistantLine("m1", usage(10, 100, 2000, 0), [{ type: "text", text: "a" }]),
        assistantLine("m2", usage(20, 200, 300, 900000), [{ type: "text", text: "b" }]),
      ],
      { agentType: "coder", description: "APPLY foo", toolUseId: "toolu_1", spawnDepth: 1 },
    );

    const read = readDelegation(jsonl);

    assert.equal(read.kind, "delegation");
    if (read.kind !== "delegation") return;
    assert.equal(read.agentId, "aaa1");
    assert.equal(read.agentType, "coder");
    assert.equal(read.description, "APPLY foo");
    assert.equal(read.toolUseId, "toolu_1");
    assert.equal(read.spawnDepth, 1);
    assert.equal(read.partial, false);
    assert.deepEqual(read.totals, {
      input: 30,
      output: 300,
      cacheCreation: 2300,
      cacheRead: 900000,
      thinkingMeasured: null,
    });
  });

  it("marks the delegation partial when a line is corrupt but still ingests the rest", async () => {
    const dir = join(workDir, "s2", "subagents");
    await mkdir(dir, { recursive: true });
    const jsonl = join(dir, "agent-bbb2.jsonl");
    await writeFile(
      jsonl,
      assistantLine("m1", usage(1, 10, 0, 0), [{ type: "text", text: "a" }]) + "\n{ broken",
      "utf8",
    );
    await writeFile(join(dir, "agent-bbb2.meta.json"), JSON.stringify({ agentType: "coder" }), "utf8");

    const read = readDelegation(jsonl);

    assert.equal(read.kind, "delegation");
    if (read.kind !== "delegation") return;
    assert.equal(read.partial, true);
    assert.equal(read.totals.output, 10);
  });

  it("reports a gap when the .meta.json is missing", async () => {
    const dir = join(workDir, "s3", "subagents");
    const jsonl = await writeDelegation(
      dir,
      "ccc3",
      [assistantLine("m1", usage(1, 10, 0, 0), [{ type: "text", text: "a" }])],
      null,
    );

    const read = readDelegation(jsonl);

    assert.equal(read.kind, "gap");
    if (read.kind !== "gap") return;
    assert.equal(read.reason, "missing-meta");
  });

  it("reports a gap — never a zero — when no turn carries usage", async () => {
    const dir = join(workDir, "s4", "subagents");
    const jsonl = await writeDelegation(
      dir,
      "ddd4",
      [JSON.stringify({ type: "assistant", message: { id: "m1", content: [] } })],
      { agentType: "coder" },
    );

    const read = readDelegation(jsonl);

    assert.equal(read.kind, "gap");
    if (read.kind !== "gap") return;
    assert.equal(read.reason, "missing-usage");
  });
});

describe("durationMs — wall time of a delegation", () => {
  it("is the span between the first and last timestamped line", async () => {
    const dir = join(workDir, "s7", "subagents");
    await mkdir(dir, { recursive: true });
    const jsonl = join(dir, "agent-hhh8.jsonl");
    const withTs = (ts: string, id: string, out: number): string =>
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: { id, model: "claude-opus-5", content: [{ type: "text", text: "a" }], usage: usage(1, out, 0, 0) },
      });
    await writeFile(
      jsonl,
      [withTs("2026-08-19T19:35:18.808Z", "m1", 10), withTs("2026-08-19T19:35:20.808Z", "m2", 20)].join("\n"),
      "utf8",
    );
    await writeFile(join(dir, "agent-hhh8.meta.json"), JSON.stringify({ agentType: "coder" }), "utf8");

    const read = readDelegation(jsonl);

    assert.equal(read.kind, "delegation");
    if (read.kind !== "delegation") return;
    assert.equal(read.durationMs, 2000);
  });

  it("is null when no line carries a timestamp", async () => {
    const dir = join(workDir, "s8", "subagents");
    const jsonl = await writeDelegation(
      dir,
      "iii9",
      [assistantLine("m1", usage(1, 10, 0, 0), [{ type: "text", text: "a" }])],
      { agentType: "coder" },
    );

    const read = readDelegation(jsonl);
    assert.equal(read.kind, "delegation");
    if (read.kind !== "delegation") return;
    assert.equal(read.durationMs, null);
  });
});

describe("readSession", () => {
  it("returns a session gap when the subagents directory cannot be read", () => {
    const session = readSession(join(workDir, "does-not-exist"));

    assert.equal(session.gaps.length, 1);
    assert.equal(session.gaps[0]!.reason, "unreadable-subagents-dir");
    assert.equal(session.delegations.length, 0);
  });

  it("separates readable delegations from gaps", async () => {
    const dir = join(workDir, "s5", "subagents");
    await writeDelegation(dir, "eee5", [assistantLine("m1", usage(1, 10, 0, 0), [{ type: "text", text: "a" }])], {
      agentType: "coder",
      description: "APPLY x",
    });
    await writeDelegation(dir, "fff6", [assistantLine("m1", usage(1, 10, 0, 0), [{ type: "text", text: "a" }])], null);

    const session = readSession(join(workDir, "s5"));

    assert.equal(session.sessionId, "s5");
    assert.equal(session.delegations.length, 1);
    assert.equal(session.gaps.length, 1);
    assert.equal(session.gaps[0]!.agentId, "fff6");
  });
});

describe("TT-1 regression — the harness figure is not the cumulative total", () => {
  it("ignores toolUseResult.totalTokens and never reads it as the total", async () => {
    const dir = join(workDir, "s6", "subagents");
    const jsonl = await writeDelegation(
      dir,
      "ggg7",
      [
        assistantLine("m1", usage(50, 1000, 20000, 0), [{ type: "text", text: "a" }]),
        assistantLine("m2", usage(2, 500, 300, 900000), [{ type: "text", text: "b" }]),
        JSON.stringify({
          type: "user",
          toolUseResult: { totalTokens: 900802, usage: usage(2, 500, 300, 900000) },
        }),
      ],
      { agentType: "coder", description: "APPLY x" },
    );

    const read = readDelegation(jsonl);

    assert.equal(read.kind, "delegation");
    if (read.kind !== "delegation") return;
    const work = read.totals.input + read.totals.output + read.totals.cacheCreation;
    assert.equal(work, 21852);
    assert.notEqual(work + read.totals.cacheRead, 900802);
    assert.equal(read.totals.output, 1500);
  });
});

describe("parseDailyBilled — billed tokens bucketed by the UTC day of the turn", () => {
  function dated(messageId: string, ts: string | null, u: Record<string, unknown>): string {
    const entry: Record<string, unknown> = {
      type: "assistant",
      message: { id: messageId, model: "claude-opus-5", content: [], usage: u },
    };
    if (ts !== null) entry["timestamp"] = ts;
    return JSON.stringify(entry);
  }

  it("sums input + output + cache_creation + cache_read per day", () => {
    const content = [
      dated("m1", "2026-08-19T10:00:00.000Z", usage(10, 5, 100, 1000)),
      dated("m2", "2026-08-20T09:00:00.000Z", usage(1, 2, 3, 4)),
    ].join("\n");

    const read = parseDailyBilled(content);

    assert.deepEqual(read.byDay.get("2026-08-19"), { billed: 1115, output: 5 });
    assert.deepEqual(read.byDay.get("2026-08-20"), { billed: 10, output: 2 });
  });

  it("counts one streamed message once, on the day of its last line", () => {
    const content = [
      dated("m1", "2026-08-19T23:59:00.000Z", usage(10, 1, 0, 0)),
      dated("m1", "2026-08-20T00:01:00.000Z", usage(10, 40, 0, 0)),
    ].join("\n");

    const read = parseDailyBilled(content);

    assert.equal(read.byDay.get("2026-08-19"), undefined);
    assert.deepEqual(read.byDay.get("2026-08-20"), { billed: 50, output: 40 });
  });

  it("refuses to place an undated turn in a day and counts it apart", () => {
    const content = [
      dated("m1", null, usage(10, 5, 0, 0)),
      dated("m2", "2026-08-20T09:00:00.000Z", usage(1, 1, 0, 0)),
    ].join("\n");

    const read = parseDailyBilled(content);

    assert.equal(read.byDay.size, 1);
    assert.equal(read.turnsWithoutDate, 1);
  });

  it("ignores lines that are not assistant turns and counts the corrupt ones", () => {
    const content = ["{ not json", JSON.stringify({ type: "user", message: { content: "hi" } })].join("\n");

    const read = parseDailyBilled(content);

    assert.equal(read.byDay.size, 0);
    assert.equal(read.corruptLines, 1);
  });
});

describe("parseDailyBilled — the same day, cut by model", () => {
  function datedModel(messageId: string, ts: string, model: string | null, u: Record<string, unknown>): string {
    const message: Record<string, unknown> = { id: messageId, content: [], usage: u };
    if (model !== null) message["model"] = model;
    return JSON.stringify({ type: "assistant", timestamp: ts, message });
  }

  it("buckets by (day, model) while the by-day view stays what it was", () => {
    const content = [
      datedModel("m1", "2026-08-19T10:00:00.000Z", "claude-opus-5", usage(10, 5, 100, 1000)),
      datedModel("m2", "2026-08-19T11:00:00.000Z", "claude-haiku-4", usage(1, 2, 3, 4)),
      datedModel("m3", "2026-08-19T12:00:00.000Z", "claude-opus-5", usage(0, 1, 0, 0)),
    ].join("\n");

    const read = parseDailyBilled(content);

    assert.deepEqual(read.byDay.get("2026-08-19"), { billed: 1126, output: 8 });
    assert.deepEqual(read.byDayModel.get("2026-08-19")?.get("claude-opus-5"), { billed: 1116, output: 6 });
    assert.deepEqual(read.byDayModel.get("2026-08-19")?.get("claude-haiku-4"), { billed: 10, output: 2 });
    assert.equal(read.turnsWithoutModel, 0);
  });

  it("a turn without message.model stays in the day total and out of the model cut, counted", () => {
    const content = [
      datedModel("m1", "2026-08-19T10:00:00.000Z", "claude-opus-5", usage(1, 1, 0, 0)),
      datedModel("m2", "2026-08-19T11:00:00.000Z", null, usage(5, 5, 0, 0)),
    ].join("\n");

    const read = parseDailyBilled(content);

    assert.deepEqual(read.byDay.get("2026-08-19"), { billed: 12, output: 6 });
    assert.deepEqual([...(read.byDayModel.get("2026-08-19") ?? new Map()).keys()], ["claude-opus-5"]);
    assert.deepEqual(read.byDayModel.get("2026-08-19")?.get("claude-opus-5"), { billed: 2, output: 1 });
    assert.equal(read.turnsWithoutModel, 1);
  });
});
