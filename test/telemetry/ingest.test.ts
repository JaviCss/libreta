import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { LibretaDB } = await import("../../src/storage/libreta-db.js");
const { projectSlug, claudeProjectsRoot, listSessionIds, buildSessionRows, ingestSession } =
  await import("../../src/telemetry/ingest.js");

let workDir: string;
const open: Array<{ close: () => void }> = [];

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-telemetry-ingest-"));
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

function line(
  messageId: string,
  output: number,
  blocks: unknown[],
  opts: { model?: string; sidechain?: boolean; cacheRead?: number; thinking?: number } = {},
): string {
  const usage: Record<string, unknown> = {
    input_tokens: 1,
    output_tokens: output,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: opts.cacheRead ?? 0,
  };
  if (opts.thinking !== undefined) usage["output_tokens_details"] = { thinking_tokens: opts.thinking };
  return JSON.stringify({
    type: "assistant",
    isSidechain: opts.sidechain ?? true,
    message: { id: messageId, model: opts.model ?? "claude-opus-5", content: blocks, usage },
  });
}

async function makeProject(): Promise<string> {
  const projectDir = join(workDir, `proj-${randomUUID()}`);
  const sessionId = "sess-abc";
  const subagents = join(projectDir, sessionId, "subagents");
  await mkdir(subagents, { recursive: true });

  await writeFile(
    join(subagents, "agent-a1.jsonl"),
    [
      line("m1", 100, [{ type: "text", text: "x".repeat(100) }]),
      line("m2", 200, [{ type: "tool_use", name: "Write", input: { file_path: "src/a.ts", content: "y" } }], {
        cacheRead: 900000,
      }),
    ].join("\r\n") + "\r\n",
    "utf8",
  );
  await writeFile(
    join(subagents, "agent-a1.meta.json"),
    JSON.stringify({ agentType: "coder", description: "APPLY foo", toolUseId: "toolu_1", spawnDepth: 1 }),
    "utf8",
  );

  await writeFile(
    join(subagents, "agent-a2.jsonl"),
    line("m1", 50, [{ type: "text", text: "z" }]) + "\n",
    "utf8",
  );

  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    [
      line("mm1", 500, [{ type: "text", text: "main prose" }], { sidechain: false, cacheRead: 40000 }),
      line("mm2", 300, [{ type: "text", text: "more" }], { sidechain: false, cacheRead: 41000 }),
      line("ms1", 999, [{ type: "text", text: "sidechain echo" }], { sidechain: true }),
    ].join("\n") + "\n",
    "utf8",
  );

  return projectDir;
}

describe("projectSlug / claudeProjectsRoot", () => {
  it("encodes a Windows cwd the way Claude Code names its project directory", () => {
    assert.equal(
      projectSlug("C:\\Users\\Javier Css\\Desktop\\LIBRETAAI\\libreta-v0.1.0\\libreta"),
      "C--Users-Javier-Css-Desktop-LIBRETAAI-libreta-v0-1-0-libreta",
    );
  });

  it("encodes a POSIX cwd", () => {
    assert.equal(projectSlug("/home/j/dev/libreta"), "-home-j-dev-libreta");
  });

  it("roots at <home>/.claude/projects", () => {
    assert.equal(claudeProjectsRoot("/home/j"), join("/home/j", ".claude", "projects"));
  });
});

describe("listSessionIds", () => {
  it("lists sessions that have a transcript, ignoring stray files", async () => {
    const projectDir = await makeProject();
    await writeFile(join(projectDir, "notes.txt"), "x", "utf8");

    assert.deepEqual(listSessionIds(projectDir), ["sess-abc"]);
  });

  it("returns an empty list for a directory that does not exist", () => {
    assert.deepEqual(listSessionIds(join(workDir, "nope")), []);
  });
});

describe("buildSessionRows — TT-5, TT-6, TT-12", () => {
  it("builds one row per (agent, model) plus the main remainder, and declares the gap", async () => {
    const projectDir = await makeProject();

    const { rows, gaps } = buildSessionRows(projectDir, "sess-abc", "2026-08-20T00:00:00.000Z");

    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.reason, "missing-meta");
    assert.equal(gaps[0]!.agentId, "a2");

    const coder = rows.find((r) => r.agent === "coder")!;
    assert.equal(coder.session_id, "sess-abc");
    assert.equal(coder.agent_id, "a1");
    assert.equal(coder.task_type, "apply");
    assert.equal(coder.description, "APPLY foo");
    assert.equal(coder.tool_use_id, "toolu_1");
    assert.equal(coder.turns, 2);
    assert.equal(coder.output_tokens, 300);
    assert.equal(coder.cache_read_tokens, 900000);
    assert.equal(coder.cache_creation_tokens, 20);
    assert.equal(coder.out_code, 200);
    assert.equal(coder.out_prose, 100);
    assert.equal(coder.thinking_method, "attributed");

    const main = rows.find((r) => r.agent === "main")!;
    assert.equal(main.agent_id, "main");
    assert.equal(main.task_type, "none");
    assert.equal(main.description, null);
    assert.equal(main.output_tokens, 800);
    assert.equal(main.cache_read_tokens, 81000);
  });

  it("carries duration_ms as null when the fixture transcripts have no timestamps", async () => {
    const projectDir = await makeProject();
    const { rows } = buildSessionRows(projectDir, "sess-abc", "2026-08-20T00:00:00.000Z");
    assert.equal(rows.every((r) => r.duration_ms === null), true);
  });

  it("does not fold sidechain turns into the main row", async () => {
    const projectDir = await makeProject();
    const { rows } = buildSessionRows(projectDir, "sess-abc", "2026-08-20T00:00:00.000Z");
    const main = rows.find((r) => r.agent === "main")!;
    assert.notEqual(main.output_tokens, 1799);
  });

  it("the six output classes of every row sum to its output_tokens — TT-4", async () => {
    const projectDir = await makeProject();
    const { rows } = buildSessionRows(projectDir, "sess-abc", "2026-08-20T00:00:00.000Z");
    for (const r of rows) {
      const sum =
        r.out_thinking + r.out_prose + r.out_tool_call + r.out_code + r.out_test + r.out_doc;
      assert.equal(sum, r.output_tokens, `row ${r.agent_id} does not reconcile`);
    }
  });

  it("reports a session gap and writes no row when the subagents dir is unreadable", () => {
    const { rows, gaps } = buildSessionRows(workDir, "not-a-session", "2026-08-20T00:00:00.000Z");
    assert.equal(rows.length, 0);
    assert.equal(gaps.some((g) => g.reason === "unreadable-subagents-dir"), true);
  });
});

async function makeToolCallProject(): Promise<string> {
  const projectDir = join(workDir, `proj-tc-${randomUUID()}`);
  const sessionId = "sess-tc";
  const subagents = join(projectDir, sessionId, "subagents");
  await mkdir(subagents, { recursive: true });

  const bash = (n: number) => ({ type: "tool_use", name: "Bash", input: { command: `echo ${n}` } });
  const twenty = Array.from({ length: 20 }, (_, i) => bash(i));
  const fifteen = Array.from({ length: 15 }, (_, i) => bash(i));

  await writeFile(
    join(subagents, "agent-b1.jsonl"),
    [
      line("t1", 400, twenty),
      line("t2", 300, fifteen),
      line("t3", 100, [{ type: "text", text: "no tools here" }], { model: "claude-haiku-4" }),
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(subagents, "agent-b1.meta.json"),
    JSON.stringify({ agentType: "coder", description: "APPLY tc", toolUseId: "toolu_tc", spawnDepth: 1 }),
    "utf8",
  );
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    line("mm1", 10, [{ type: "text", text: "main" }], { sidechain: false }) + "\n",
    "utf8",
  );
  return projectDir;
}

describe("tool call counter — TM-1", () => {
  it("counts 35 tool_use blocks as 35 while out_tool_call keeps its own byte-share value", async () => {
    const projectDir = await makeToolCallProject();

    const { rows } = buildSessionRows(projectDir, "sess-tc", "2026-08-21T00:00:00.000Z");
    const opus = rows.find((r) => r.agent === "coder" && r.model === "claude-opus-5")!;

    assert.equal(opus.tool_calls, 35);
    assert.equal(opus.out_tool_call, 700, "the token figure stays a token figure");
    assert.equal(opus.output_tokens, 700);
  });

  it("a turn group with no tool_use block counts a real 0, which is not the NULL gap", async () => {
    const projectDir = await makeToolCallProject();
    const { rows } = buildSessionRows(projectDir, "sess-tc", "2026-08-21T00:00:00.000Z");

    const haiku = rows.find((r) => r.agent === "coder" && r.model === "claude-haiku-4")!;
    assert.equal(haiku.tool_calls, 0);
    assert.notEqual(haiku.tool_calls, null);
  });

  it("splits the count per model, like every other column of the row", async () => {
    const projectDir = await makeToolCallProject();
    const { rows } = buildSessionRows(projectDir, "sess-tc", "2026-08-21T00:00:00.000Z");

    const coder = rows.filter((r) => r.agent === "coder");
    assert.equal(coder.length, 2);
    assert.equal(
      coder.reduce((a, r) => a + (r.tool_calls ?? 0), 0),
      35,
    );
  });
});

describe("ingestSession — TT-8", () => {
  it("persists the rows and re-ingesting does not double the series", async () => {
    const projectDir = await makeProject();
    const db = freshDb();

    const first = ingestSession(db, projectDir, "sess-abc");
    const second = ingestSession(db, projectDir, "sess-abc");

    assert.equal(first.rows.length, second.rows.length);
    const stored = db.telemetryQuery({ session_id: "sess-abc" });
    assert.equal(stored.length, first.rows.length);
    assert.equal(
      stored.reduce((a, r) => a + r.output_tokens, 0),
      1100,
    );
  });

  it("TH-4: a snapshot gap from replaceSessionTelemetry is merged into SessionRows.gaps", async () => {
    const projectDir = await makeProject();
    const db = freshDb();
    const snapshotGap = {
      kind: "gap" as const,
      agentId: null,
      path: "sess-abc",
      reason: "snapshot-capture-failed" as const,
      detail: "disk full",
    };
    db.replaceSessionTelemetry = () => ({ snapshotGap });

    const result = ingestSession(db, projectDir, "sess-abc");

    assert.ok(result.gaps.includes(snapshotGap));
  });
});
