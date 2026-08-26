/**
 * Report-time aggregation: money is computed here and never stored, and the
 * orchestrator's spend is published as an explicit remainder instead of being
 * spread across the task rows
 * (the telemetry design notes, Decision 5).
 */

import type { LibretaDB } from "../storage/libreta-db.js";
import { MAIN_AGENT_ID } from "./ingest.js";
import { costOf, type PriceTable } from "./prices.js";
import type {
  ComparableSnapshotGroup,
  OutputClass,
  ReportGap,
  SnapshotReason,
  TelemetryAxis,
  TelemetryFilter,
  TelemetryGroup,
  TelemetryRow,
} from "./types.js";

/** Fixed rendering/insertion order of the six output classes — design.md Decision 1. */
export const OUTPUT_CLASS_ORDER: readonly OutputClass[] = [
  "thinking",
  "prose",
  "tool_call",
  "code",
  "test",
  "doc",
];

export const ATTRIBUTION_NOTE =
  "input/output/cache_creation/cache_read and thinking (when the provider metered it) are measured; " +
  "the prose/tool_call/code/test/doc split is attributed by byte share and is an approximation.";

export const MEASURED_NOTE =
  "input/output/cache_creation/cache_read los reporta el proveedor por turno, y thinking también cuando lo midió; " +
  "nada de este bloque se reparte ni se estima.";

export const ATTRIBUTED_BLOCK_NOTE =
  "el reparto prosa/tool_call/código/test/doc se atribuye por proporción de bytes: es una aproximación, no una medición.";

export const THINKING_ATTRIBUTED_REASON =
  "alguna fila del grupo no trae thinking_tokens del proveedor: su thinking se reparte por bytes.";

/** The billed components, always measured, never a byte-share figure. */
export interface MeasuredComponents {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
}

/** The measured half of a group: billed components plus thinking when metered. */
export interface MeasuredBlock {
  readonly method: "measured";
  readonly components: MeasuredComponents;
  readonly classes: Partial<Record<OutputClass, number>>;
}

/** The byte-share half of a group. `thinking_reason` is set only when it lands here. */
export interface AttributedBlock {
  readonly method: "attributed";
  readonly classes: Partial<Record<OutputClass, number>>;
  readonly thinking_reason: string | null;
}

/** The two labelled halves of a group; the six classes still sum `output_tokens`. */
export interface ReportBlocks {
  readonly measured: MeasuredBlock;
  readonly attributed: AttributedBlock;
}

/** A group with the sealed work/cache/total split and its report-time cost. */
export interface ReportGroup extends TelemetryGroup {
  readonly work: number;
  readonly cache: number;
  readonly total: number;
  readonly cost_usd: number | null;
  readonly blocks: ReportBlocks;
}

/** The orchestrator's own spend — a total, never attributable to a task. */
export interface UnattributedMain {
  readonly rows: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
  readonly work: number;
  readonly cache: number;
  readonly total: number;
  readonly cost_usd: number | null;
}

/** The measured/attributed method notes, stated once per report — TH-11. */
export interface FormatNotes {
  readonly measured: string;
  readonly attributed: string;
}

export interface Report {
  readonly axis: TelemetryAxis;
  readonly groups: readonly ReportGroup[];
  readonly unattributedMain: UnattributedMain;
  readonly unpricedModels: readonly string[];
  readonly priceSource: string | null;
  readonly priceDate: string | null;
  readonly currency: string | null;
  readonly attributionNote: string;
  readonly partialRows: number;
  readonly formatNotes: FormatNotes;
}

export interface ReportOptions {
  readonly axis: TelemetryAxis;
  readonly filter?: TelemetryFilter;
  readonly prices?: PriceTable;
}

function billable(r: TelemetryRow) {
  return {
    input: r.input_tokens,
    output: r.output_tokens,
    cache_creation: r.cache_creation_tokens,
    cache_read: r.cache_read_tokens,
  };
}

const CLASS_VALUE_OF: Record<OutputClass, (g: TelemetryGroup) => number> = {
  thinking: (g) => g.out_thinking,
  prose: (g) => g.out_prose,
  tool_call: (g) => g.out_tool_call,
  code: (g) => g.out_code,
  test: (g) => g.out_test,
  doc: (g) => g.out_doc,
};

function classesInOrder(g: TelemetryGroup, members: readonly OutputClass[]): Partial<Record<OutputClass, number>> {
  const classes: Partial<Record<OutputClass, number>> = {};
  for (const cls of OUTPUT_CLASS_ORDER) {
    if (members.includes(cls)) classes[cls] = CLASS_VALUE_OF[cls](g);
  }
  return classes;
}

function blocksOf(g: TelemetryGroup): ReportBlocks {
  const thinkingAttributed = g.attributed;
  return {
    measured: {
      method: "measured",
      components: {
        input_tokens: g.input_tokens,
        output_tokens: g.output_tokens,
        cache_creation_tokens: g.cache_creation_tokens,
        cache_read_tokens: g.cache_read_tokens,
      },
      classes: classesInOrder(g, thinkingAttributed ? [] : ["thinking"]),
    },
    attributed: {
      method: "attributed",
      classes: classesInOrder(
        g,
        thinkingAttributed
          ? ["thinking", "prose", "tool_call", "code", "test", "doc"]
          : ["prose", "tool_call", "code", "test", "doc"],
      ),
      thinking_reason: thinkingAttributed ? THINKING_ATTRIBUTED_REASON : null,
    },
  };
}

export function buildReport(db: LibretaDB, options: ReportOptions): Report {
  const filter = options.filter ?? {};
  const prices = options.prices;

  const groups = db.telemetryAggregate(options.axis, { ...filter, exclude_agent: MAIN_AGENT_ID });
  const workingRows = db.telemetryQuery({ ...filter, exclude_agent: MAIN_AGENT_ID });
  const mainRows = db.telemetryQuery({ ...filter, agent: MAIN_AGENT_ID });

  const unpriced = new Set<string>();
  const costByKey = new Map<string, number | null>();

  const accrue = (key: string, r: TelemetryRow): void => {
    if (!prices) {
      costByKey.set(key, null);
      return;
    }
    const cost = costOf(billable(r), r.model, prices);
    if (cost === null) {
      unpriced.add(r.model);
      if (!costByKey.has(key)) costByKey.set(key, null);
      return;
    }
    const soFar = costByKey.get(key);
    costByKey.set(key, soFar === null || soFar === undefined ? cost : soFar + cost);
  };

  for (const r of workingRows) accrue(String(r[options.axis]), r);

  const reportGroups: ReportGroup[] = groups.map((g) => {
    const work = g.input_tokens + g.output_tokens + g.cache_creation_tokens;
    return {
      ...g,
      work,
      cache: g.cache_read_tokens,
      total: work + g.cache_read_tokens,
      cost_usd: costByKey.get(g.key) ?? null,
      blocks: blocksOf(g),
    };
  });

  let mainCost: number | null = prices ? 0 : null;
  const main = mainRows.reduce(
    (acc, r) => {
      if (prices && mainCost !== null) {
        const cost = costOf(billable(r), r.model, prices);
        if (cost === null) {
          unpriced.add(r.model);
          mainCost = null;
        } else {
          mainCost += cost;
        }
      }
      return {
        rows: acc.rows + 1,
        input_tokens: acc.input_tokens + r.input_tokens,
        output_tokens: acc.output_tokens + r.output_tokens,
        cache_creation_tokens: acc.cache_creation_tokens + r.cache_creation_tokens,
        cache_read_tokens: acc.cache_read_tokens + r.cache_read_tokens,
      };
    },
    { rows: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
  );

  const mainWork = main.input_tokens + main.output_tokens + main.cache_creation_tokens;

  return {
    axis: options.axis,
    groups: reportGroups,
    unattributedMain: {
      ...main,
      work: mainWork,
      cache: main.cache_read_tokens,
      total: mainWork + main.cache_read_tokens,
      cost_usd: main.rows === 0 ? null : mainCost,
    },
    unpricedModels: [...unpriced].sort(),
    priceSource: prices?.source ?? null,
    priceDate: prices?.date ?? null,
    currency: prices?.currency ?? null,
    attributionNote: ATTRIBUTION_NOTE,
    partialRows: [...workingRows, ...mainRows].filter((r) => r.partial === 1).length,
    formatNotes: { measured: MEASURED_NOTE, attributed: ATTRIBUTED_BLOCK_NOTE },
  };
}

/** How a `thinking` figure's method compares between the two sides of a comparison — TH-9. */
export type ThinkingLabel = "measured" | "attributed" | "mixed";

function thinkingLabelOf(measuredShare: number): ThinkingLabel {
  if (measuredShare >= 1) return "measured";
  if (measuredShare <= 0) return "attributed";
  return "mixed";
}

/** One axis-group's figures on one side of a comparison, read off `ComparableSnapshotGroup`. */
export interface CompareGroupSide {
  readonly key: string;
  readonly components: MeasuredComponents;
  readonly classes: Readonly<Record<OutputClass, number>>;
  readonly measuredShare: number;
  readonly thinkingLabel: ThinkingLabel;
  /** `null` is the gap (`tool_calls_gap` names the reason); a real `0` is a legitimate value. */
  readonly tool_calls: number | null;
  readonly tool_calls_gap: ReportGap["reason"] | null;
}

/** One side of a comparison: either a frozen snapshot or the live series computed on read. */
export interface CompareSide {
  readonly source: "snapshot" | "live";
  readonly snapshotId: string | null;
  readonly takenAt: string | null;
  readonly reason: SnapshotReason | null;
  readonly groups: readonly CompareGroupSide[];
}

export interface CompareReport {
  readonly axis: TelemetryAxis;
  readonly left: CompareSide;
  readonly right: CompareSide;
}

export interface CompareOptions {
  readonly axis: TelemetryAxis;
  readonly snapshotId: string;
  /** A second snapshot id, or the literal `"live"` for the current series. */
  readonly against: string | "live";
}

function toCompareGroups(groups: readonly ComparableSnapshotGroup[], axis: TelemetryAxis): CompareGroupSide[] {
  return groups
    .filter((g) => g.axis === axis)
    .map((g) => ({
      key: g.key,
      components: {
        input_tokens: g.input_tokens,
        output_tokens: g.output_tokens,
        cache_creation_tokens: g.cache_creation_tokens,
        cache_read_tokens: g.cache_read_tokens,
      },
      classes: g.classes,
      measuredShare: g.measured_share,
      thinkingLabel: thinkingLabelOf(g.measured_share),
      tool_calls: g.tool_calls,
      tool_calls_gap: g.tool_calls_gap,
    }));
}

/**
 * Compare two points in time on the same axis: a snapshot against a second
 * snapshot, or a snapshot against the current live series — TH-9/TH-10. Both
 * sides are read through the one canonical shape (`design.md.addendum-1.md`),
 * so the caller never needs to know which side is frozen.
 */
export function compareReport(db: LibretaDB, options: CompareOptions): CompareReport {
  const leftSnapshot = db.snapshotById(options.snapshotId);
  if (!leftSnapshot) throw new Error(`snapshot not found: ${options.snapshotId}`);

  const left: CompareSide = {
    source: "snapshot",
    snapshotId: leftSnapshot.id,
    takenAt: leftSnapshot.taken_at,
    reason: leftSnapshot.reason,
    groups: toCompareGroups(db.snapshotGroups(leftSnapshot.id), options.axis),
  };

  let right: CompareSide;
  if (options.against === "live") {
    if (!leftSnapshot.session_id) {
      throw new Error(`snapshot ${leftSnapshot.id} has no session_id — cannot compare it against a live series`);
    }
    right = {
      source: "live",
      snapshotId: null,
      takenAt: null,
      reason: null,
      groups: toCompareGroups(db.liveComparableGroups(leftSnapshot.session_id), options.axis),
    };
  } else {
    const rightSnapshot = db.snapshotById(options.against);
    if (!rightSnapshot) throw new Error(`snapshot not found: ${options.against}`);
    right = {
      source: "snapshot",
      snapshotId: rightSnapshot.id,
      takenAt: rightSnapshot.taken_at,
      reason: rightSnapshot.reason,
      groups: toCompareGroups(db.snapshotGroups(rightSnapshot.id), options.axis),
    };
  }

  return { axis: options.axis, left, right };
}
