/**
 * Output classification: meter what the provider meters, attribute the rest.
 *
 * The choice of byte share over re-tokenising, and why every derived class is
 * labelled `attributed`, is argued in
 * the telemetry design notes, Decision 3.
 */

import type { ContentBlock, Method, OutputClass, OutputSplit, Turn } from "./types.js";

/** Data-driven classification rules. Re-classifying history is a re-run, not a schema change. */
export interface ClassificationRules {
  /** Tool names whose payload is a file write. */
  readonly writeTools: readonly string[];
  /** Keys in a write tool's input that may carry the target path. */
  readonly pathKeys: readonly string[];
  /** Globs whose match makes a write a `test`. Evaluated before `docExtensions`. */
  readonly testGlobs: readonly string[];
  /** Extensions whose match makes a write a `doc`. */
  readonly docExtensions: readonly string[];
}

export const DEFAULT_CLASSIFICATION_RULES: ClassificationRules = {
  writeTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
  pathKeys: ["file_path", "notebook_path", "path"],
  testGlobs: ["test/**", "tests/**", "e2e/**", "**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
  docExtensions: [".md", ".mdx", ".rst", ".txt", ".adoc"],
};

const ALL_CLASSES: readonly OutputClass[] = ["thinking", "prose", "tool_call", "code", "test", "doc"];

function emptyClasses(): Record<OutputClass, number> {
  return { thinking: 0, prose: 0, tool_call: 0, code: 0, test: 0, doc: 0 };
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

const globCache = new Map<string, RegExp>();

function matchesGlob(path: string, glob: string): boolean {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(path);
}

function normalisePath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

function targetPath(block: ContentBlock, rules: ClassificationRules): string | null {
  const input = block.input;
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of rules.pathKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return normalisePath(value);
  }
  return null;
}

/** Which output class a single content block belongs to. */
export function classifyBlock(
  block: ContentBlock,
  rules: ClassificationRules = DEFAULT_CLASSIFICATION_RULES,
): OutputClass {
  if (block.type === "thinking" || block.type === "redacted_thinking") return "thinking";
  if (block.type === "text") return "prose";
  if (block.type !== "tool_use") return "tool_call";
  if (!block.name || !rules.writeTools.includes(block.name)) return "tool_call";

  const path = targetPath(block, rules);
  if (path === null) return "tool_call";

  const tail = path.split("/").pop() ?? path;
  for (const glob of rules.testGlobs) {
    if (matchesGlob(path, glob) || matchesGlob(tail, glob)) return "test";
  }
  const lower = path.toLowerCase();
  for (const ext of rules.docExtensions) {
    if (lower.endsWith(ext.toLowerCase())) return "doc";
  }
  return "code";
}

function blockBytes(block: ContentBlock): number {
  if (block.type === "text") return Buffer.byteLength(block.text ?? "", "utf8");
  if (block.type === "thinking" || block.type === "redacted_thinking") {
    return Buffer.byteLength(block.thinking ?? "", "utf8");
  }
  try {
    return Buffer.byteLength(JSON.stringify(block.input ?? {}), "utf8");
  } catch {
    return 0;
  }
}

/**
 * Split a turn's `output_tokens` across the six classes.
 *
 * The split reconciles exactly: the largest class absorbs the rounding
 * remainder, so the six values always sum to `output_tokens`.
 */
export function classifyTurn(turn: Turn, rules: ClassificationRules = DEFAULT_CLASSIFICATION_RULES): OutputSplit {
  const classes = emptyClasses();
  const output = Math.max(0, turn.usage.output);
  const metered = turn.usage.thinkingMeasured;
  const thinkingMethod: Method = metered === null ? "attributed" : "measured";

  let remaining = output;
  if (metered !== null) {
    const thinking = Math.min(Math.max(0, metered), output);
    classes.thinking = thinking;
    remaining = output - thinking;
  }

  if (remaining === 0) return { classes, thinkingMethod };

  const pool: Array<{ cls: OutputClass; bytes: number }> = [];
  let totalBytes = 0;
  for (const block of turn.blocks) {
    const cls = classifyBlock(block, rules);
    if (metered !== null && cls === "thinking") continue;
    const bytes = blockBytes(block);
    pool.push({ cls, bytes });
    totalBytes += bytes;
  }

  if (pool.length === 0 || totalBytes === 0) {
    const fallback: OutputClass = pool.length > 0 ? pool[0]!.cls : "prose";
    classes[fallback] += remaining;
    return { classes, thinkingMethod };
  }

  let assigned = 0;
  for (const entry of pool) {
    const share = Math.floor((remaining * entry.bytes) / totalBytes);
    classes[entry.cls] += share;
    assigned += share;
  }

  const leftover = remaining - assigned;
  if (leftover > 0) {
    let largest: OutputClass = "prose";
    let best = -1;
    for (const cls of ALL_CLASSES) {
      if (metered !== null && cls === "thinking") continue;
      if (classes[cls] > best) {
        best = classes[cls];
        largest = cls;
      }
    }
    if (best <= 0) largest = pool[0]!.cls;
    classes[largest] += leftover;
  }

  return { classes, thinkingMethod };
}

/** Add class totals across turns. One attributed turn degrades the whole label. */
export function sumSplits(splits: readonly OutputSplit[]): OutputSplit {
  const classes = emptyClasses();
  let thinkingMethod: Method = "measured";
  for (const split of splits) {
    for (const cls of ALL_CLASSES) classes[cls] += split.classes[cls];
    if (split.thinkingMethod === "attributed") thinkingMethod = "attributed";
  }
  return { classes, thinkingMethod };
}
