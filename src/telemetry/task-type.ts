/**
 * Declared prefix map from a delegation's `description` to a task type.
 *
 * Unmatched descriptions become `other` and the raw text is stored alongside,
 * so widening the map later re-classifies history without losing rows
 * (the telemetry design notes, Decision 4).
 */

export type TaskTypePrefixes = Readonly<Record<string, string>>;

export const DEFAULT_TASK_TYPE_PREFIXES: TaskTypePrefixes = {
  APPLY: "apply",
  VERIFY: "verify",
  PROPOSE: "propose",
  SPEC: "spec",
  DESIGN: "design",
  TASKS: "tasks",
  ARCHIVE: "archive",
  REFUTE: "refute",
};

/** Task type for a delegation description, or `other` when no prefix matches. */
export function taskTypeOf(
  description: string | null | undefined,
  prefixes: TaskTypePrefixes = DEFAULT_TASK_TYPE_PREFIXES,
): string {
  if (typeof description !== "string") return "other";
  const first = description.trim().split(/\s+/)[0];
  if (!first) return "other";
  const upper = first.toUpperCase();
  return prefixes[upper] ?? "other";
}
