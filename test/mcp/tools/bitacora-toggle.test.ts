/**
 * Tests for the bitácora WRITE-path gating (libreta-bitacora Lote 2.1 / 2.3).
 *
 * The flag file lives at ~/.libreta/bitacora.json, resolved via home().
 * We point HOME at a temp dir so the toggle is fully sandboxed. Asserts:
 *   - OFF ⇒ lib_bitacora_add refuses to write and says so; reads still work.
 *   - ON  ⇒ lib_bitacora_add writes normally.
 *   - Entries written while ON survive a disable (data preserved).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { LibretaDB } = await import("../../../src/storage/libreta-db.js");
const { ALL_TOOLS } = await import("../../../src/mcp/tools/index.js");
const { setBitacoraEnabled } = await import("../../../src/components/bitacora-config.js");

function toolByName(name: string) {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}
function parse(result: { content: Array<{ type: "text"; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

let workDir: string;
let db: InstanceType<typeof LibretaDB>;

const entry = {
  project: "libreta",
  date: "2026-07-21",
  headline: "toggle test",
  summary: "a day",
};

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "libreta-bitacora-gate-"));
  process.env.HOME = workDir;
  process.env.USERPROFILE = workDir;
  await mkdir(join(workDir, ".libreta"), { recursive: true });
  db = new LibretaDB(join(workDir, "libreta.db"));
  db.init();
});

after(async () => {
  try { db.close(); } catch { /* ignore */ }
  try { await rm(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("bitacora toggle — write-path gating", () => {
  it("ON ⇒ lib_bitacora_add writes and returns an id", async () => {
    setBitacoraEnabled(true);
    const out = parse(await toolByName("lib_bitacora_add").handler(entry, db));
    assert.equal(typeof out.id, "string");
    assert.equal(out.skipped, undefined);
  });

  it("OFF ⇒ lib_bitacora_add refuses to write and reports it", async () => {
    setBitacoraEnabled(false);
    const out = parse(await toolByName("lib_bitacora_add").handler(entry, db));
    assert.equal(out.skipped, true);
    assert.equal(out.enabled, false);
    assert.match(out.message as string, /apagada/);
    // No id ⇒ nothing was written.
    assert.equal(out.id, undefined);
  });

  it("reads still work while OFF, and entries survive a disable", async () => {
    // Exactly one entry exists — the one written in the first (ON) test.
    // The OFF add above must NOT have added a second.
    setBitacoraEnabled(false);
    const day = parse(await toolByName("lib_bitacora_day").handler(
      { project: entry.project, date: entry.date },
      db,
    ));
    const entries = day.entries as unknown[];
    assert.equal(entries.length, 1, "exactly the ON-written entry survives the disable");

    // Re-enable resumes writing.
    setBitacoraEnabled(true);
    const out = parse(await toolByName("lib_bitacora_add").handler(entry, db));
    assert.equal(typeof out.id, "string");
  });
});
