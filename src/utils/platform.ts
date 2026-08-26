/**
 * Platform / OS detection utilities.
 */

import { homedir, platform as osPlatform } from "node:os";

/**
 * Resolve the user's home directory.
 *
 * Honors `$HOME` if set, so tests can sandbox libreta's state to a temp
 * dir, and users can redirect it on any platform. Falls back to
 * `os.homedir()` (which uses `USERPROFILE` on Windows, `HOME` on POSIX).
 *
 * Single source of truth — adapters and CLI must use this, never `homedir()`
 * directly.
 *
 * Why: `os.homedir()` ignores `$HOME` on Windows, which breaks test
 * isolation and would prevent users from redirecting libreta to a
 * different home if they ever wanted to.
 */
export function home(): string {
  return process.env.HOME ?? homedir();
}

export function isWindows(): boolean {
  return osPlatform() === "win32";
}
