import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  STARTUP_CEILING_TOKENS,
  CLAUDE_MD_CEILING_LINES,
  LONG_SESSION_MS,
  UNMEASURABLE_SIGNALS,
  startupTokensOf,
  summariseStartup,
  summariseLongSessions,
  readClaudeMdFiles,
  readSessionStartups,
  readDailyTokens,
} = await import("../../src/telemetry/signals.js");

let workDir: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-signals-"));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function turn(input: number, cacheCreation: number, cacheRead: number) {
  return {
    messageId: `msg-${input}-${cacheCreation}-${cacheRead}`,
    model: "claude-opus-5",
    usage: { input, output: 10, cacheCreation, cacheRead, thinkingMeasured: null },
    blocks: [],
  };
}

describe("startup tokens", () => {
  it("bills the first main turn as input + cache_creation + cache_read", () => {
    const tokens = startupTokensOf([turn(2, 65591, 0), turn(3, 100, 70000)]);
    assert.equal(tokens, 65593);
  });

  it("refuses a number when the session has no main turn", () => {
    assert.equal(startupTokensOf([]), null);
  });

  it("counts sessions against the 15k ceiling and skips the ones it could not read", () => {
    const summary = summariseStartup([
      { sessionId: "a", startupTokens: 9000, durationMs: null },
      { sessionId: "b", startupTokens: 65593, durationMs: null },
      { sessionId: "c", startupTokens: 21000, durationMs: null },
      { sessionId: "d", startupTokens: null, durationMs: null },
    ]);
    assert.equal(summary.ceiling, STARTUP_CEILING_TOKENS);
    assert.equal(summary.sessionsMeasured, 3);
    assert.equal(summary.sessionsUnread, 1);
    assert.equal(summary.under, 1);
    assert.equal(summary.over, 2);
    assert.equal(summary.median, 21000);
    assert.equal(summary.max, 65593);
  });
});

describe("sessions over four hours", () => {
  it("counts only sessions whose wall time is known and exceeds four hours", () => {
    const summary = summariseLongSessions([
      { sessionId: "a", startupTokens: null, durationMs: LONG_SESSION_MS + 1 },
      { sessionId: "b", startupTokens: null, durationMs: 60_000 },
      { sessionId: "c", startupTokens: null, durationMs: null },
    ]);
    assert.equal(summary.sessionsMeasured, 2);
    assert.equal(summary.sessionsUnread, 1);
    assert.equal(summary.over, 1);
    assert.equal(summary.longestMs, LONG_SESSION_MS + 1);
  });
});

describe("CLAUDE.md line budget", () => {
  it("counts lines of every loaded file and marks the ones over 200", async () => {
    const homeDir = join(workDir, "home");
    const projectDir = join(workDir, "project");
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(homeDir, ".claude", "CLAUDE.md"), "x\n".repeat(652), "utf8");
    await writeFile(join(projectDir, "CLAUDE.md"), "y\n".repeat(10), "utf8");

    const files = readClaudeMdFiles(homeDir, projectDir);
    const byScope = new Map(files.map((f) => [f.scope, f]));

    assert.equal(byScope.get("user")?.lines, 652);
    assert.equal(byScope.get("user")?.overCeiling, true);
    assert.equal(byScope.get("project")?.lines, 10);
    assert.equal(byScope.get("project")?.overCeiling, false);
    assert.equal(byScope.get("project-local")?.present, false);
    assert.equal(byScope.get("project-local")?.lines, null);
    assert.equal(CLAUDE_MD_CEILING_LINES, 200);
  });
});

describe("sessions read off disk", () => {
  it("reads startup and wall time from the main transcript, ignoring sidechains", async () => {
    const projectDir = join(workDir, "transcripts");
    await mkdir(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-19T19:23:10.791Z",
        message: {
          id: "m1",
          model: "claude-opus-5",
          content: [],
          usage: { input_tokens: 2, cache_creation_input_tokens: 65591, cache_read_input_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-08-19T19:24:00.000Z",
        message: {
          id: "m2",
          model: "claude-opus-5",
          content: [],
          usage: { input_tokens: 5, cache_creation_input_tokens: 900_000, cache_read_input_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-20T01:23:10.791Z",
        message: {
          id: "m3",
          model: "claude-opus-5",
          content: [],
          usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 70_000 },
        },
      }),
    ];
    await writeFile(join(projectDir, "s1.jsonl"), lines.join("\n"), "utf8");

    const sessions = readSessionStartups(projectDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.sessionId, "s1");
    assert.equal(sessions[0]!.startupTokens, 65593);
    assert.equal(sessions[0]!.durationMs, 6 * 60 * 60 * 1000);
  });
});

describe("the signals that stay unmeasurable", () => {
  it("names the missing datum and its source instead of producing a number", () => {
    const ids = UNMEASURABLE_SIGNALS.map((s) => s.id).sort();
    assert.deepEqual(ids, ["cost-per-merged-pr", "mcp-spend-share", "rework-after-degradation"]);
    for (const signal of UNMEASURABLE_SIGNALS) {
      assert.ok(signal.missing.length > 0);
      assert.ok(signal.source.length > 0);
    }
  });
});

describe("tokens per day", () => {
  function line(
    messageId: string,
    ts: string,
    u: { input: number; output: number; cc: number; cr: number },
    sidechain = false,
  ): string {
    const entry: Record<string, unknown> = {
      type: "assistant",
      timestamp: ts,
      message: {
        id: messageId,
        model: "claude-opus-5",
        content: [],
        usage: {
          input_tokens: u.input,
          output_tokens: u.output,
          cache_creation_input_tokens: u.cc,
          cache_read_input_tokens: u.cr,
        },
      },
    };
    if (sidechain) entry["isSidechain"] = true;
    return JSON.stringify(entry);
  }

  it("adds the main thread and its sub-agents once each, bucketed by day", async () => {
    const projectDir = join(workDir, "daily-a");
    await mkdir(join(projectDir, "s1", "subagents"), { recursive: true });
    await writeFile(
      join(projectDir, "s1.jsonl"),
      [
        line("m1", "2026-08-19T10:00:00.000Z", { input: 10, output: 5, cc: 100, cr: 0 }),
        line("d1", "2026-08-19T10:05:00.000Z", { input: 9, output: 9, cc: 9, cr: 9 }, true),
        line("m2", "2026-08-20T10:00:00.000Z", { input: 1, output: 2, cc: 3, cr: 4 }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectDir, "s1", "subagents", "agent-d1.jsonl"),
      line("d1", "2026-08-19T10:05:00.000Z", { input: 20, output: 30, cc: 0, cr: 50 }),
      "utf8",
    );

    const summary = readDailyTokens(projectDir);

    assert.deepEqual(summary.days, [
      { day: "2026-08-19", billedTokens: 215, outputTokens: 35 },
      { day: "2026-08-20", billedTokens: 10, outputTokens: 2 },
    ]);
    assert.equal(summary.transcriptsRead, 2);
  });

  it("publishes what it could not date instead of folding it into a day", async () => {
    const projectDir = join(workDir, "daily-b");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "s2.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: {
            id: "u1",
            model: "claude-opus-5",
            content: [],
            usage: { input_tokens: 7, output_tokens: 7 },
          },
        }),
        line("m1", "2026-08-21T10:00:00.000Z", { input: 1, output: 1, cc: 0, cr: 0 }),
      ].join("\n"),
      "utf8",
    );

    const summary = readDailyTokens(projectDir);

    assert.equal(summary.days.length, 1);
    assert.equal(summary.turnsWithoutDate, 1);
  });

  it("declares no number and no day when there is nothing readable", () => {
    const summary = readDailyTokens(join(workDir, "daily-missing"));

    assert.deepEqual(summary.days, []);
    assert.equal(summary.transcriptsRead, 0);
  });

  it("states the part of the playbook metric it cannot cover", () => {
    const summary = readDailyTokens(join(workDir, "daily-missing"));

    assert.match(summary.missingPart, /developer/);
    assert.ok(summary.definition.includes("UTC"));
  });
});
