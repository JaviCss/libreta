/**
 * Price tables are input, never state.
 *
 * No price is persisted: a cost is computed at report time from a table the
 * caller supplies, and a report that states a cost must name that table's
 * source and date (the telemetry design notes,
 * Failure modes).
 */

import { readFile } from "node:fs/promises";

/** Dollars per million tokens, per component. */
export interface ModelPrices {
  readonly input: number;
  readonly output: number;
  readonly cache_creation: number;
  readonly cache_read: number;
}

export interface PriceTable {
  readonly source: string;
  readonly date: string;
  readonly currency: string;
  readonly perMTok: Readonly<Record<string, ModelPrices>>;
}

/** The four billable components of a row or a group. */
export interface BillableTokens {
  readonly input: number;
  readonly output: number;
  readonly cache_creation: number;
  readonly cache_read: number;
}

function componentOf(raw: unknown, key: keyof ModelPrices): number {
  const value = (raw as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`price table: model price is missing a finite \`${key}\``);
  }
  return value;
}

/** Read and validate a price table. Refuses anything it cannot attribute. */
export async function loadPriceTable(path: string): Promise<PriceTable> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

  if (typeof raw["source"] !== "string" || raw["source"].trim() === "") {
    throw new Error("price table: `source` is required — a cost with no attribution is not reportable");
  }
  if (typeof raw["date"] !== "string" || raw["date"].trim() === "") {
    throw new Error("price table: `date` is required — prices move and an undated table cannot be audited");
  }
  const perMTokRaw = raw["perMTok"];
  if (!perMTokRaw || typeof perMTokRaw !== "object" || Object.keys(perMTokRaw).length === 0) {
    throw new Error("price table: `perMTok` must carry at least one model");
  }

  const perMTok: Record<string, ModelPrices> = {};
  for (const [model, prices] of Object.entries(perMTokRaw as Record<string, unknown>)) {
    if (!prices || typeof prices !== "object") {
      throw new Error(`price table: \`perMTok.${model}\` is not an object`);
    }
    perMTok[model] = {
      input: componentOf(prices, "input"),
      output: componentOf(prices, "output"),
      cache_creation: componentOf(prices, "cache_creation"),
      cache_read: componentOf(prices, "cache_read"),
    };
  }

  return {
    source: raw["source"],
    date: raw["date"],
    currency: typeof raw["currency"] === "string" ? raw["currency"] : "USD",
    perMTok,
  };
}

/** Cost in the table's currency, or null when the table does not price that model. */
export function costOf(tokens: BillableTokens, model: string, table: PriceTable): number | null {
  const prices = table.perMTok[model];
  if (!prices) return null;
  return (
    (tokens.input * prices.input +
      tokens.output * prices.output +
      tokens.cache_creation * prices.cache_creation +
      tokens.cache_read * prices.cache_read) /
    1_000_000
  );
}
