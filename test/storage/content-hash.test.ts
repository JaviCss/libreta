/**
 * Tests for storage/content-hash.ts — normalize() + contentHash().
 *
 * These are pure functions (no DB), so no temp-file setup is needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { normalize, contentHash } = await import("../../src/storage/content-hash.js");

const base = {
  type: "architecture",
  title: "Use libreta for memory",
  what: "Implemented persistent memory component",
  why: "User wanted 5th pata",
  where: "src/components/memory.ts",
  learned: "Mirror Engram's toolset but in TS",
};

describe("storage/content-hash — normalize()", () => {
  it("trims leading/trailing whitespace", () => {
    assert.equal(normalize("  hello  "), "hello");
  });

  it("collapses internal whitespace runs to a single space", () => {
    assert.equal(normalize("a\t\tb   c\n\nd"), "a b c d");
  });

  it("is a no-op on already-normalized text", () => {
    assert.equal(normalize("a b c"), "a b c");
  });

  it("does NOT lowercase (case is meaningful)", () => {
    assert.equal(normalize("Foo BAR"), "Foo BAR");
  });
});

describe("storage/content-hash — contentHash()", () => {
  it("returns a 64-char lowercase hex sha256 string", () => {
    const h = contentHash(base);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("is stable across calls with identical input", () => {
    assert.equal(contentHash(base), contentHash(base));
  });

  it("whitespace-only differences collide (normalize)", () => {
    const spaced = {
      ...base,
      title: "  Use   libreta\tfor  memory  ",
      what: "Implemented persistent memory component ",
    };
    assert.equal(contentHash(base), contentHash(spaced));
  });

  it("a different type does NOT collide (type is in the hash)", () => {
    assert.notEqual(contentHash(base), contentHash({ ...base, type: "gotcha" }));
  });

  it("a different content field does NOT collide", () => {
    assert.notEqual(contentHash(base), contentHash({ ...base, learned: "something else" }));
  });

  it("excludes id/project/session/topic/timestamps (fields not in the signature don't change the hash)", () => {
    // contentHash only accepts the six content fields; passing extra keys must
    // not affect the result. We prove it by hashing an object with extra
    // identity/metadata keys and comparing to the clean base.
    const withExtras = {
      ...base,
      id: "01SOMEULID",
      project: "other-project",
      session_id: "sess-1",
      topic_key: "topic-A",
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
      revision_count: 99,
    } as unknown as typeof base;
    assert.equal(contentHash(base), contentHash(withExtras));
  });

  it("does not forge field boundaries (moving text across fields changes the hash)", () => {
    const moved = { ...base, title: base.title + base.what, what: "" };
    assert.notEqual(contentHash(base), contentHash(moved));
  });
});
