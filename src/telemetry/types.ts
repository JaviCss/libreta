/**
 * Shared types for the per-agent token telemetry capability.
 *
 * Rationale, evidence and the rejected alternatives live in
 * the telemetry design notes.
 */

/** How a figure was obtained. Never mix the two in a report without the label. */
export type Method = "measured" | "attributed";

/** The six output classes a turn's `output_tokens` is split across. */
export type OutputClass = "thinking" | "prose" | "tool_call" | "code" | "test" | "doc";

/** A content block as it appears in an assistant message. */
export interface ContentBlock {
  readonly type: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly text?: string;
  readonly thinking?: string;
}

/** The four provider-metered components plus thinking when the provider meters it. */
export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
  /** `output_tokens_details.thinking_tokens`, or null when the provider omits it. */
  readonly thinkingMeasured: number | null;
}

/** One assistant turn: one `message.id`, however many JSONL lines carried it. */
export interface Turn {
  readonly messageId: string;
  readonly model: string;
  readonly usage: UsageTotals;
  readonly blocks: readonly ContentBlock[];
}

export type GapReason =
  | "missing-meta"
  | "missing-usage"
  | "unreadable-transcript"
  | "unreadable-meta"
  | "unreadable-subagents-dir"
  | "tool-calls-not-counted"
  | "zero-turns"
  | "mixed-model-duration"
  | "snapshot-capture-failed";

/** A refusal to produce a number, with the reason. Never stored as a zero. */
export interface Gap {
  readonly kind: "gap";
  readonly agentId: string | null;
  readonly path: string;
  readonly reason: GapReason;
  readonly detail?: string;
}

/**
 * A refusal to publish a reported figure, with its reason. Never a sentinel and
 * never a zero: a consumer that forgets to narrow it gets a type error.
 */
export interface ReportGap {
  readonly kind: "gap";
  readonly reason: GapReason;
  readonly detail: string;
  /** Rows of the group that lacked the datum. Still present in the report. */
  readonly gapped_rows: number;
}

export function isReportGap(value: unknown): value is ReportGap {
  return typeof value === "object" && value !== null && (value as ReportGap).kind === "gap";
}

/** One sub-agent's transcript, read and summed over every turn. */
export interface DelegationRead {
  readonly kind: "delegation";
  readonly agentId: string;
  readonly path: string;
  readonly agentType: string;
  readonly description: string | null;
  readonly toolUseId: string | null;
  readonly spawnDepth: number | null;
  readonly turns: readonly Turn[];
  readonly totals: UsageTotals;
  /** Wall time of the delegation, or null when the transcript carries no timestamps. */
  readonly durationMs: number | null;
  readonly partial: boolean;
  readonly corruptLines: number;
}

export interface SessionRead {
  readonly sessionId: string;
  readonly delegations: readonly DelegationRead[];
  readonly gaps: readonly Gap[];
}

/** Per-turn output split. `thinking` is measured when the provider reported it. */
export interface OutputSplit {
  readonly classes: Readonly<Record<OutputClass, number>>;
  readonly thinkingMethod: Method;
}

/** A telemetry row, at grain `(session_id, agent_id, model)`. */
export interface TelemetryRow {
  readonly session_id: string;
  readonly agent_id: string;
  readonly model: string;
  readonly agent: string;
  readonly task_type: string;
  readonly description: string | null;
  readonly tool_use_id: string | null;
  readonly spawn_depth: number | null;
  readonly duration_ms: number | null;
  readonly turns: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
  readonly out_thinking: number;
  readonly out_prose: number;
  readonly out_tool_call: number;
  readonly out_code: number;
  readonly out_test: number;
  readonly out_doc: number;
  readonly thinking_method: Method;
  /** Counted `tool_use` blocks; `null` on a row ingested before the counter existed. */
  readonly tool_calls: number | null;
  readonly partial: number;
  readonly ingested_at: string;
}

/** Filter accepted by the read-only query surface. `from`/`to` bound `ingested_at`. */
export interface TelemetryFilter {
  readonly session_id?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly task_type?: string;
  readonly from?: string;
  readonly to?: string;
  /** Drop rows of this agent. Used to keep the main remainder out of task groups. */
  readonly exclude_agent?: string;
}

/** Columns a report may group by. Anything else is refused. */
export const TELEMETRY_AXES = ["agent", "model", "task_type", "session_id"] as const;

export type TelemetryAxis = (typeof TELEMETRY_AXES)[number];

/** One grouped total. `attributed` is true when any member row's thinking was attributed. */
export interface TelemetryGroup {
  key: string;
  rows: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  out_thinking: number;
  out_prose: number;
  out_tool_call: number;
  out_code: number;
  out_test: number;
  out_doc: number;
  attributed: boolean;
}

/** Separator between the two axis values of a crossed volume group key. */
export const VOLUME_KEY_SEPARATOR = " × ";

/** Stated whenever a volume report is cut by model, so the counts are not added up. */
export const VOLUME_SESSIONS_NOTE =
  "las sesiones por modelo no suman al total de sesiones: una sesión que usó dos modelos cuenta una vez bajo cada uno.";

/** One grouped volume figure. A figure that cannot be produced is a `ReportGap`. */
export interface TelemetryVolumeGroup {
  key: string;
  key_parts: string[];
  rows: number;
  sessions: number;
  turns: number;
  tool_calls: number | ReportGap;
  tool_calls_per_turn: number | ReportGap;
  /** `null` when no contributing row carried timestamps; never a zero. */
  duration_ms: number | null | ReportGap;
  gapped_rows: number;
}

/** Why a snapshot was taken. Open set (design.md Decision 5); at least these two are legal. */
export type SnapshotReason = "pre-replace" | "manual";

/** Axis a snapshot's totals/output-class rows are grouped by, `total` is the un-grouped sum. */
export type SnapshotAxis = TelemetryAxis | "total";

/** One row of `telemetry_snapshot`: the event, never updated or deleted once written. */
export interface TelemetrySnapshotRow {
  readonly id: string;
  readonly taken_at: string;
  readonly reason: SnapshotReason;
  /** Set for `pre-replace`, `null` for other reasons. */
  readonly session_id: string | null;
  readonly schema_version: number;
}

/** One row of `telemetry_snapshot_total`: the aggregate for (snapshot × axis × group). */
export interface TelemetrySnapshotTotalRow {
  readonly snapshot_id: string;
  readonly axis: SnapshotAxis;
  readonly group_key: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
  readonly turns: number;
  readonly sessions: number;
  /** `null` when any contributing row lacked the counter; never a 0 standing in for unknown. */
  readonly tool_calls: number | null;
  /** The `GapReason` text when `tool_calls` is `null`; `null` when `tool_calls` is real. */
  readonly tool_calls_gap: GapReason | null;
}

/** One row of `telemetry_snapshot_output_class`: one of the six classes for (snapshot × axis × group). */
export interface TelemetrySnapshotOutputClassRow {
  readonly snapshot_id: string;
  readonly axis: SnapshotAxis;
  readonly group_key: string;
  readonly class: OutputClass;
  readonly class_total: number;
  /** Same value on all 6 class rows of one (snapshot, axis, group) — design.md Decision 3/4. */
  readonly measured_share: number;
}

/** One row of `telemetry_snapshot_note`: an append-only, dated comment on a snapshot. */
export interface TelemetrySnapshotNoteRow {
  readonly id: string;
  readonly snapshot_id: string;
  readonly created_at: string;
  /** `null` when unknown — a real state, not `''`. */
  readonly author: string | null;
  readonly text: string;
}

/**
 * One axis-group's aggregate figures, in the shape a snapshot freezes them and a
 * live series can also produce on demand — the common currency `compareReport`
 * (`src/telemetry/report.ts`) reads from both sides of a comparison (TH-9/TH-10).
 */
export interface ComparableSnapshotGroup {
  readonly axis: SnapshotAxis;
  readonly key: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
  readonly turns: number;
  readonly sessions: number;
  readonly tool_calls: number | null;
  readonly tool_calls_gap: GapReason | null;
  readonly classes: Readonly<Record<OutputClass, number>>;
  readonly measured_share: number;
}
