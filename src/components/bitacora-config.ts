/**
 * Bitácora write toggle. One boolean stored in `~/.libreta/bitacora.json`.
 * Gates only the write path (lib_bitacora_add); reads always work. Absent or
 * corrupt file degrades to the default (ON) instead of throwing into a tool
 * handler. Toggling never touches the DB.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { home } from "../utils/platform.js";

export const BITACORA_DEFAULT_ENABLED = true;

export function bitacoraConfigPath(): string {
  return join(home(), ".libreta", "bitacora.json");
}

interface BitacoraConfigShape {
  enabled: boolean;
}

export function isBitacoraEnabled(path: string = bitacoraConfigPath()): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BitacoraConfigShape>;
    return typeof parsed.enabled === "boolean" ? parsed.enabled : BITACORA_DEFAULT_ENABLED;
  } catch {
    return BITACORA_DEFAULT_ENABLED;
  }
}

export function setBitacoraEnabled(enabled: boolean, path: string = bitacoraConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ enabled } satisfies BitacoraConfigShape, null, 2) + "\n", "utf8");
}

/** One-line notice when the bitácora is OFF, or `null` when it is ON. */
export function bitacoraOffReminder(path: string = bitacoraConfigPath()): string | null {
  if (isBitacoraEnabled(path)) return null;
  return "bitácora apagada — no se está guardando el índice diario (editá ~/.libreta/bitacora.json).";
}
