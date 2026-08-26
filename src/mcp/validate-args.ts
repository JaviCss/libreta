/**
 * Minimal JSON-Schema validation for MCP tool arguments.
 *
 * The tool inputSchemas were previously decorative — the server passed
 * `request.params.arguments` straight to handlers, so a client could send
 * unknown keys, wrong types, out-of-enum values, or megabyte-sized strings.
 * This validator enforces the subset of JSON Schema our tools actually use
 * (flat object schemas: type/enum/required) without pulling in ajv.
 *
 * Deliberately strict: unknown top-level keys are rejected, because with an
 * LLM caller an unknown key is a hallucinated argument, not forward compat.
 */

import type { ToolSchema } from "./tools/_types.js";

/** Hard cap for any string argument — protects SQLite + FTS5 from megabyte blobs. */
const MAX_STRING_LENGTH = 100_000;

/** Cap for the diagnostic key lists in the "missing required" error message. */
const MAX_KEY_LIST_LENGTH = 200;

/**
 * Render a list of keys as `[a, b, c]`, truncating with an ellipsis once the
 * rendered body exceeds MAX_KEY_LIST_LENGTH so a pathological payload (many
 * keys, or long key names) can't blow up the error message.
 */
function formatKeyList(keys: string[]): string {
  const kept: string[] = [];
  let length = 0;
  for (const key of keys) {
    const added = length === 0 ? key.length : key.length + 2; // ", " separator
    if (length + added > MAX_KEY_LIST_LENGTH) {
      kept.push("…");
      break;
    }
    kept.push(key);
    length += added;
  }
  return `[${kept.join(", ")}]`;
}

interface PropertySchema {
  type?: string;
  enum?: unknown[];
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeOf(value) === "object";
    case "array":
      return Array.isArray(value);
    default:
      return true; // unknown declared type — don't block the call
  }
}

/**
 * Validate raw MCP arguments against a tool's inputSchema. Throws a
 * descriptive error naming the tool and the offending field. Returns the
 * arguments (unmodified) for handler consumption.
 */
export function validateToolArgs(
  toolName: string,
  schema: ToolSchema,
  args: unknown,
): Record<string, unknown> {
  const input = args ?? {};
  if (typeOf(input) !== "object") {
    throw new Error(`${toolName}: arguments must be an object, got ${typeOf(input)}`);
  }
  const obj = input as Record<string, unknown>;
  const properties = schema.properties as Record<string, PropertySchema>;

  const required = schema.required ?? [];
  const missing = required.filter((key) => obj[key] === undefined || obj[key] === null);
  if (missing.length > 0) {
    const received = Object.keys(obj);
    throw new Error(
      `${toolName}: missing required argument "${missing[0]}"\n` +
        `  recibidas: ${formatKeyList(received)}\n` +
        `  faltan: ${formatKeyList(missing)}`,
    );
  }

  for (const [key, value] of Object.entries(obj)) {
    const prop = properties[key];
    if (!prop) {
      throw new Error(
        `${toolName}: unknown argument "${key}". Valid arguments: ${Object.keys(properties).join(", ")}`,
      );
    }
    if (value === undefined || value === null) continue; // treat as omitted
    if (prop.type && !matchesType(value, prop.type)) {
      throw new Error(
        `${toolName}: argument "${key}" must be a ${prop.type}, got ${typeOf(value)}`,
      );
    }
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
      throw new Error(
        `${toolName}: argument "${key}" exceeds ${MAX_STRING_LENGTH} chars`,
      );
    }
    if (prop.enum && !prop.enum.includes(value)) {
      throw new Error(
        `${toolName}: argument "${key}" must be one of: ${prop.enum.join(", ")}`,
      );
    }
  }

  return obj;
}
