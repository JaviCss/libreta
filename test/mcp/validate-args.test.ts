/**
 * Tests for the MCP argument validator (Sprint 1: schemas are a contract,
 * not documentation). Exercises the validator directly and through a real
 * tool schema (lib_save) to make sure the wiring assumptions hold.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { validateToolArgs } = await import("../../src/mcp/validate-args.js");
const { libSaveTool } = await import("../../src/mcp/tools/lib-save.js");

const SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    count: { type: "number" },
    kind: { type: "string", enum: ["a", "b"] },
    extra: { type: "object" },
  },
  required: ["name"],
};

describe("mcp/validate-args", () => {
  it("accepts valid args and returns them", () => {
    const out = validateToolArgs("t", SCHEMA, { name: "x", count: 2, kind: "a" });
    assert.deepEqual(out, { name: "x", count: 2, kind: "a" });
  });

  it("rejects missing required arguments", () => {
    assert.throws(() => validateToolArgs("t", SCHEMA, { count: 1 }), /missing required argument "name"/);
  });

  it("names the received keys and the full missing list on partial args", () => {
    const MULTI = {
      type: "object" as const,
      properties: {
        project: { type: "string" },
        title: { type: "string" },
        type: { type: "string" },
        what: { type: "string" },
        why: { type: "string" },
        where: { type: "string" },
        learned: { type: "string" },
      },
      required: ["project", "title", "type", "what", "why", "where", "learned"],
    };
    try {
      validateToolArgs("lib_save", MULTI, { project: "p", title: "t", type: "note", what: "w" });
      assert.fail("expected validateToolArgs to throw on partial args");
    } catch (err) {
      const message = (err as Error).message;
      assert.match(message, /missing required argument "why"/);
      assert.match(message, /recibidas: \[project, title, type, what\]/);
      assert.match(message, /faltan: \[why, where, learned\]/);
    }
  });

  it("rejects undefined args when something is required", () => {
    assert.throws(() => validateToolArgs("t", SCHEMA, undefined), /missing required argument/);
  });

  it("rejects unknown arguments (hallucinated keys)", () => {
    assert.throws(() => validateToolArgs("t", SCHEMA, { name: "x", bogus: 1 }), /unknown argument "bogus"/);
  });

  it("rejects wrong types", () => {
    assert.throws(() => validateToolArgs("t", SCHEMA, { name: 42 }), /"name" must be a string/);
    assert.throws(() => validateToolArgs("t", SCHEMA, { name: "x", count: "5" }), /"count" must be a number/);
    assert.throws(() => validateToolArgs("t", SCHEMA, { name: "x", extra: [] }), /"extra" must be a object/);
  });

  it("rejects out-of-enum values", () => {
    assert.throws(() => validateToolArgs("t", SCHEMA, { name: "x", kind: "z" }), /must be one of: a, b/);
  });

  it("rejects oversized strings", () => {
    assert.throws(
      () => validateToolArgs("t", SCHEMA, { name: "x".repeat(100_001) }),
      /exceeds 100000 chars/,
    );
  });

  it("rejects non-object argument payloads", () => {
    assert.throws(() => validateToolArgs("t", SCHEMA, "nope"), /must be an object/);
    assert.throws(() => validateToolArgs("t", SCHEMA, [1, 2]), /must be an object/);
  });

  it("enforces a real tool schema (lib_save): enum + required", () => {
    assert.throws(
      () =>
        validateToolArgs("lib_save", libSaveTool.inputSchema, {
          project: "p",
          title: "t",
          type: "bogus-type",
          what: "w",
          why: "y",
          where: ".",
          learned: "l",
        }),
      /must be one of/,
    );
    assert.throws(
      () => validateToolArgs("lib_save", libSaveTool.inputSchema, { project: "p" }),
      /missing required argument/,
    );
  });
});
