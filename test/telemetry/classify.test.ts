import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { classifyBlock, classifyTurn, sumSplits, DEFAULT_CLASSIFICATION_RULES } = await import(
  "../../src/telemetry/classify.js"
);

import type { ContentBlock, Turn, UsageTotals } from "../../src/telemetry/types.js";

function turn(blocks: ContentBlock[], output: number, thinking?: number): Turn {
  const usage: UsageTotals = {
    input: 1,
    output,
    cacheCreation: 0,
    cacheRead: 0,
    thinkingMeasured: thinking ?? null,
  };
  return { messageId: "m1", model: "claude-opus-5", usage, blocks };
}

function write(path: string, content: string): ContentBlock {
  return { type: "tool_use", name: "Write", input: { file_path: path, content } };
}

describe("classifyBlock — the rules are data, not constants", () => {
  it("classifies a text block as prose", () => {
    assert.equal(classifyBlock({ type: "text", text: "hola" }, DEFAULT_CLASSIFICATION_RULES), "prose");
  });

  it("classifies a non-writing tool_use as tool_call", () => {
    assert.equal(
      classifyBlock({ type: "tool_use", name: "Bash", input: { command: "ls" } }, DEFAULT_CLASSIFICATION_RULES),
      "tool_call",
    );
  });

  it("classifies a Write onto src/ as code", () => {
    assert.equal(classifyBlock(write("src/telemetry/x.ts", "a"), DEFAULT_CLASSIFICATION_RULES), "code");
  });

  it("classifies an Edit onto test/ as test, not code", () => {
    const block: ContentBlock = {
      type: "tool_use",
      name: "Edit",
      input: { file_path: "test/telemetry/x.test.ts", old_string: "a", new_string: "b" },
    };
    assert.equal(classifyBlock(block, DEFAULT_CLASSIFICATION_RULES), "test");
  });

  it("classifies a Write onto a .md as doc", () => {
    assert.equal(classifyBlock(write("openspec/changes/x/design.md", "a"), DEFAULT_CLASSIFICATION_RULES), "doc");
  });

  it("honours a caller-supplied rule set instead of the default one", () => {
    const rules = {
      ...DEFAULT_CLASSIFICATION_RULES,
      testGlobs: ["spec/**"],
      docExtensions: [".rst"],
    };
    assert.equal(classifyBlock(write("spec/a.ts", "x"), rules), "test");
    assert.equal(classifyBlock(write("docs/a.rst", "x"), rules), "doc");
    assert.equal(classifyBlock(write("test/a.ts", "x"), rules), "code");
  });

  it("treats a write tool with no resolvable path as a tool_call", () => {
    assert.equal(
      classifyBlock({ type: "tool_use", name: "Write", input: {} }, DEFAULT_CLASSIFICATION_RULES),
      "tool_call",
    );
  });
});

describe("classifyTurn — TT-4, the classes add up to output_tokens", () => {
  it("reconciles exactly on a mixed turn", () => {
    const split = classifyTurn(
      turn([{ type: "text", text: "x".repeat(300) }, write("src/a.ts", "y".repeat(700))], 1000),
    );
    const sum = Object.values(split.classes).reduce((a, b) => a + b, 0);
    assert.equal(sum, 1000);
  });

  it("reconciles exactly when the byte share does not divide evenly", () => {
    const split = classifyTurn(
      turn(
        [
          { type: "text", text: "a".repeat(33) },
          { type: "text", text: "b".repeat(33) },
          write("src/a.ts", "c".repeat(34)),
        ],
        7,
      ),
    );
    const sum = Object.values(split.classes).reduce((a, b) => a + b, 0);
    assert.equal(sum, 7);
  });

  it("puts a tools-only turn entirely in tool-derived classes, not prose", () => {
    const split = classifyTurn(
      turn(
        [
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
        ],
        500,
      ),
    );
    assert.equal(split.classes.prose, 0);
    assert.equal(split.classes.code, 0);
    assert.equal(split.classes.tool_call, 500);
  });

  it("puts a prose-only turn entirely in prose", () => {
    const split = classifyTurn(turn([{ type: "text", text: "hola".repeat(50) }], 120));
    assert.equal(split.classes.prose, 120);
  });

  it("reports thinking as measured when the provider metered it", () => {
    const split = classifyTurn(
      turn([{ type: "thinking", thinking: "z".repeat(400) }, { type: "text", text: "ok" }], 200, 15),
    );
    assert.equal(split.thinkingMethod, "measured");
    assert.equal(split.classes.thinking, 15);
    assert.equal(split.classes.prose, 185);
  });

  it("attributes thinking by byte share when the provider did not meter it", () => {
    const split = classifyTurn(
      turn([{ type: "thinking", thinking: "z".repeat(50) }, { type: "text", text: "y".repeat(50) }], 100),
    );
    assert.equal(split.thinkingMethod, "attributed");
    assert.equal(split.classes.thinking, 50);
    assert.equal(split.classes.prose, 50);
  });

  it("clamps a metered thinking count that exceeds the turn output", () => {
    const split = classifyTurn(turn([{ type: "thinking", thinking: "z" }], 10, 99));
    const sum = Object.values(split.classes).reduce((a, b) => a + b, 0);
    assert.equal(sum, 10);
    assert.equal(split.classes.thinking, 10);
  });

  it("falls back to prose when a turn reports output with no content blocks", () => {
    const split = classifyTurn(turn([], 42));
    assert.equal(split.classes.prose, 42);
  });

  it("TT-3 — a tool-heavy turn set does not read as written code", () => {
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 35; i++) blocks.push({ type: "tool_use", name: "Bash", input: { command: "npm test" } });
    for (let i = 0; i < 14; i++) blocks.push({ type: "thinking", thinking: "t".repeat(20) });
    for (let i = 0; i < 8; i++) blocks.push({ type: "text", text: "p".repeat(20) });

    const split = classifyTurn(turn(blocks, 18152, 4000));

    assert.equal(split.classes.code, 0);
    assert.equal(split.thinkingMethod, "measured");
    assert.ok(split.classes.tool_call > 0);
    assert.equal(
      Object.values(split.classes).reduce((a, b) => a + b, 0),
      18152,
    );
  });
});

describe("sumSplits", () => {
  it("adds class totals across turns and degrades the label to attributed if any turn was", () => {
    const a = classifyTurn(turn([{ type: "text", text: "aaa" }], 100, 0));
    const b = classifyTurn(turn([{ type: "text", text: "bbb" }], 50));
    const total = sumSplits([a, b]);
    assert.equal(total.classes.prose, 150);
    assert.equal(total.thinkingMethod, "attributed");
  });

  it("keeps the measured label when every turn was measured", () => {
    const a = classifyTurn(turn([{ type: "text", text: "aaa" }], 100, 0));
    const b = classifyTurn(turn([{ type: "text", text: "bbb" }], 50, 0));
    assert.equal(sumSplits([a, b]).thinkingMethod, "measured");
  });
});
