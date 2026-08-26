/**
 * Public types and error taxonomy for mem_judge (change `mem-judge`, Part B).
 *
 * The verdict is the unit of Layer 2 (the semantic verdict): given a pair of
 * observations, the runner produces ONE `Verdict`. The `Relation` enum is
 * frozen (sealed by `persona-criteria` Part A and reused here from
 * `src/types/memory.ts`).
 *
 * Errors are typed so callers can branch (`instanceof ErrCLINotInstalled`)
 * and so log lines can render different messages for "missing CLI" vs
 * "malformed verdict". They all extend `MemJudgeError` so a single
 * `catch (err: MemJudgeError)` still works.
 */

import type { Relation } from "../types/memory.js";

/**
 * The semantic verdict Layer 2 produces for a candidate pair.
 *
 * - `relation` MUST be one of the closed vocabulary (RELATIONS).
 * - `confidence` is a real number in [0, 1] (the model's self-rated certainty).
 * - `reasoning` is a short, human-readable explanation the user can read
 *   in `--json` output. Capped at 200 chars by the parser so the runner
 *   doesn't store novels.
 */
export interface Verdict {
  relation: Relation;
  confidence: number;
  reasoning: string;
}

/**
 * Base class for all mem_judge errors. Callers can do
 * `catch (err: MemJudgeError)` and then narrow with `instanceof`.
 */
export class MemJudgeError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * The CLI binary is missing or not installed on the current PATH.
 *
 * Thrown by the factory's detect step AND by `ClaudeRunner.compare()` when
 * the underlying spawn raises ENOENT. The user-visible remediation is
 * "install the missing CLI" — the message MUST name the binary.
 */
export class ErrCLINotInstalled extends MemJudgeError {
  constructor(binary: string, opts?: { cause?: unknown }) {
    super(`mem_judge: CLI binary "${binary}" is not installed or not on PATH`, opts);
  }
}

/**
 * The CLI ran but produced output we couldn't parse into a Verdict — either
 * the envelope is malformed, the inner JSON is broken, a required field is
 * missing, or a value is out of range (e.g. confidence > 1). The user-visible
 * remediation is "retry, or fix the model output if this persists".
 */
export class ErrInvalidEnvelope extends MemJudgeError {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(`mem_judge: invalid verdict envelope — ${message}`, opts);
  }
}

/**
 * The verdict's `relation` is not in the closed vocabulary. The model
 * emitted a string that looks plausible but isn't part of the enum
 * (e.g. "is_similar_to"). Strict — we MUST reject because storing an
 * unknown value would break later queries against `RELATIONS`.
 */
export class ErrUnknownRelation extends MemJudgeError {
  constructor(badValue: string, opts?: { cause?: unknown }) {
    super(
      `mem_judge: unknown relation "${badValue}" (not in closed vocabulary ${[
        "conflicts_with",
        "supersedes",
        "scoped",
        "related",
        "compatible",
        "not_conflict",
      ].join(", ")})`,
      opts,
    );
  }
}
