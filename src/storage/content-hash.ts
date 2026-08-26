/**
 * Deterministic content hashing for observation deduplication.
 *
 * The hash is a stable fingerprint of an observation's *content* — used as the
 * dedup key so that re-saving the same fact bumps an existing row instead of
 * inserting a duplicate. Uses Node's built-in `crypto` (no new dependency).
 *
 * Fields hashed (order fixed): type ∥ title ∥ what ∥ why ∥ where ∥ learned.
 *   - `type` is included: the same text as a `gotcha` vs a `decision` is a
 *     different observation.
 *   - Identity / bucket / metadata fields are EXCLUDED (not in the input type):
 *     id, project, session_id, topic_key, created_at, updated_at, revision_count.
 *
 * normalize(): trim, then collapse internal whitespace runs to a single space.
 * Deterministic, no locale, no lowercasing (case is meaningful in code/paths).
 * Fields are joined with a single space so text moved across field boundaries
 * produces a different hash.
 */

import { createHash } from "node:crypto";

/** The content fields that participate in the hash, in canonical order. */
export interface HashableContent {
  type: string;
  title: string;
  what: string;
  why: string;
  where: string;
  learned: string;
}

/** Trim and collapse internal whitespace runs to a single space. */
export function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * sha256 (hex) of the normalized content fields joined in canonical order.
 * Deterministic and stable across processes/platforms.
 */
export function contentHash(input: HashableContent): string {
  const joined = [input.type, input.title, input.what, input.why, input.where, input.learned]
    .map(normalize)
    .join(" ");
  return createHash("sha256").update(joined).digest("hex");
}
