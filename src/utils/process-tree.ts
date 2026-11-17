/**
 * Cross-platform executable lookup & process-tree cleanup (macOS, Linux, Windows).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";

export const NON_INTERACTIVE_ENV = {
  CI: "1",
  TERM: "dumb",
  NO_COLOR: "1",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  PYTHONUNBUFFERED: "1",
  PYDEVD_DISABLE_FILE_VALIDATION: "1",
} satisfies Record<string, string>;

export function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      fs.accessSync(candidate, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds an executable file on PATH (or resolves explicit relative/absolute paths).
 * Never returns directories.
 */
export function whichExecutable(cmd: string, extraDirs: string[] = []): string | null {
  if (!cmd) {
    return null;
  }
  if (
    path.isAbsolute(cmd) ||
    cmd.startsWith("./") ||
    cmd.startsWith("../") ||
    cmd.startsWith(".\\") ||
    cmd.startsWith("..\\")
  ) {
    const abs = path.resolve(cmd);
    return isExecutableFile(abs) ? abs : null;
  }

  const pathDirs = [
    ...extraDirs,
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
  ];
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".COM"])
    : [""];

  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${cmd}${ext}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Collects descendant PIDs recursively on macOS & Linux via pgrep -P.
 */
function collectDescendantPids(rootPid: number): number[] {
  if (process.platform === "win32" || rootPid <= 0) {
    return [];
  }
  const visited = new Set<number>();
  const queue = [rootPid];
  const descendants: number[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    visited.add(current);
    try {
      const out = execFileSync("pgrep", ["-P", String(current)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      });
      for (const raw of out.split(/\s+/)) {
        const pid = Number.parseInt(raw, 10);
        if (Number.isInteger(pid) && pid > 0 && !visited.has(pid)) {
          descendants.push(pid);
          queue.push(pid);
        }
      }
    } catch {
      // pgrep exits 1 when there are no children
    }
  }
  return descendants;
}

export function isPidAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Terminates a spawned child process AND its entire descendant process tree
 * across macOS, Linux, and Windows, escalating SIGTERM -> SIGKILL cleanly.
 */
export async function terminateProcessTree(
  proc: ChildProcess | undefined,
  opts: { graceMs?: number; detachedGroup?: boolean } = {},
): Promise<void> {
  if (!proc || proc.pid === undefined) {
    return;
  }
  const pid = proc.pid;
  const graceMs = opts.graceMs ?? 600;

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 3000 });
    } catch {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
    return;
  }

  const descendants = collectDescendantPids(pid);

  if (opts.detachedGroup) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  for (const childPid of descendants.toReversed()) {
    try {
      process.kill(childPid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const anyAlive = isPidAlive(pid) || descendants.some(isPidAlive);
    if (!anyAlive) {
      return;
    }
    await sleep(40);
  }

  const lateDescendants = collectDescendantPids(pid);
  const allChildren = [...new Set([...descendants, ...lateDescendants])];
  if (opts.detachedGroup) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  for (const childPid of allChildren.toReversed()) {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
}
