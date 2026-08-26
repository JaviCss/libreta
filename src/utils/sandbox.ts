/**
 * Filesystem sandbox for MCP tool arguments.
 *
 * The MCP tools run driven by an LLM, which makes every path argument a
 * potential prompt-injection vector ("export to ~/.bashrc"). Engram's
 * threat model treats path traversal through MCP APIs as in-scope; we do
 * the same by confining file arguments to an allowlist of roots:
 *
 *   - the libreta data dir (~/.libreta) — where the DB and exports live
 *   - the server's working directory — the project the agent is working on
 *
 * The CLI is intentionally NOT sandboxed: a human typing `memory export
 * --file` already has a shell and needs no confinement.
 */

import { isAbsolute, join, relative, resolve, sep, dirname, basename } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { home, isWindows } from "./platform.js";

/** Directories MCP tools are allowed to read/write files in. */
export function allowedFileRoots(): string[] {
  return [join(home(), ".libreta"), process.cwd()];
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve a path argument coming from an MCP tool call and assert it lands
 * inside one of the allowed roots. Throws with an actionable message
 * otherwise. Returns the fully-resolved absolute path.
 *
 * @param raw - The caller-supplied path.
 * @param roots - Allowed roots; defaults to `allowedFileRoots()`.
 * @returns The fully-resolved absolute path.
 * @throws When the path is empty, contains NUL bytes or a `..` segment, or
 *         lands outside every allowed root once links are resolved.
 */
export function assertSandboxedPath(raw: string, roots: string[] = allowedFileRoots()): string {
  if (!raw || !raw.trim()) {
    throw new Error("file path must not be empty");
  }
  if (raw.includes("\0")) {
    throw new Error("file path must not contain NUL bytes");
  }
  // Defense in depth: reject explicit `..` segments even though resolve()
  // collapses them — a traversal attempt is never a legitimate input here.
  //
  // On Win32, the strict `segments.includes("..")` check is bypassable: a
  // segment like `.. ` or `..` (dotdot + trailing dot/space) is NOT equal to
  // `..` lexicographically, and `path.resolve()` does NOT strip the trailing
  // dot/space either. But Win32 file APIs DO strip them at I/O time, so the
  // OS sees the segment as `..` and walks up one level. We reject any segment
  // that begins with `..` followed ONLY by dots/spaces (i.e. that would
  // canonicalize to a `..` traversal on Win32) — SEC-1/SEC-2.
  const segments = raw.split(/[\\/]+/);
  if (segments.some((s) => /^\.\.[\s.]*$/.test(s))) {
    throw new Error(`file path must not contain '..' segments: ${raw}`);
  }
  const resolved = resolve(raw);

  const containmentTarget = resolveSymlinksForContainment(resolved);
  const containmentRoots = roots.map((root) => resolveRootForContainment(resolve(root)));

  if (!containmentRoots.some((root) => isWithin(root, containmentTarget))) {
    throw new Error(
      `file path outside allowed directories: ${containmentTarget}. ` +
        `Allowed roots: ${roots.map((r) => resolve(r)).join(", ")}`,
    );
  }
  return resolved;
}

function realpathFor(path: string): string {
  return isWindows() ? realpathSync.native(path) : realpathSync(path);
}

/**
 * Resolve symlinks for the containment check without breaking the
 * write-a-new-file case. Walks up from `target` until it finds an existing
 * ancestor, canonicalizes that ancestor, then re-appends the non-existent
 * tail lexically. Throws if the ancestor cannot be resolved.
 */
function resolveSymlinksForContainment(target: string): string {
  let existing = target;
  let tail = "";
  while (true) {
    try {
      // statSync throws ENOENT on missing paths; we use it as a probe so we
      // never hit realpath on a non-existent path (which would also throw).
      statSync(existing);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(existing);
      if (parent === existing) {
        // Hit the filesystem root without finding anything. Fall back to
        // the lexical path; the isWithin check below will catch it.
        return target;
      }
      tail = join(basename(existing), tail);
      existing = parent;
    }
  }
  const realExisting = realpathFor(existing);
  return tail ? join(realExisting, tail) : realExisting;
}

/** `resolveSymlinksForContainment`, falling back to the lexical path on error. */
function resolveRootForContainment(root: string): string {
  try {
    return resolveSymlinksForContainment(root);
  } catch {
    return root;
  }
}

/**
 * Validate a caller-supplied string that becomes ONE path segment.
 *
 * `what` names the thing in the message ("change name", "ticket id"), so the
 * rule lives in one place while the error still tells the caller which of its
 * arguments was refused. Callers that build a path out of user input must go
 * through here: it is what stops `../../..` from becoming a directory the tool
 * writes into.
 */
export function assertSafePathSegment(what: string, name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    throw new Error(`${what} must not be empty`);
  }
  if (/[\\/]/.test(trimmed) || trimmed === "." || trimmed === ".." || trimmed.includes("\0")) {
    throw new Error(
      `${what} must be a single directory name (no path separators or '..'): ${name}`,
    );
  }
  return trimmed;
}

/**
 * Validate an OpenSpec change name used to build paths under
 * openspec/changes/. Must be a single path segment — no separators, no
 * `..`, no absolute paths — so `rename()` can never escape the tree.
 */
export function assertSafeChangeName(name: string): string {
  return assertSafePathSegment("change name", name);
}
