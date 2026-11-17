/**
 * Path normalization (leading @ stripping, file:// URL conversion) and
 * safe source-line window extraction around stopped frames.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceContextLine, SourceContextSnippet } from "../types.ts";

/**
 * Strips leading '@' (some models emit '@src/foo.ts' in tool arguments)
 * and resolves against cwd.
 */
export function resolveToolPath(rawPath: string, cwd: string): string {
  const trimmed = rawPath.trim();
  const stripped = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (stripped.startsWith("file://")) {
    try {
      return fileURLToPath(stripped);
    } catch {
      // fall through
    }
  }
  if (stripped.startsWith("~/") || stripped === "~") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? cwd;
    return stripped === "~" ? home : path.resolve(home, stripped.slice(2));
  }
  return path.resolve(cwd, stripped);
}

export function normalizeFileUrlOrPath(urlOrPath: string | undefined): string | undefined {
  if (!urlOrPath) {
    return undefined;
  }
  if (urlOrPath.startsWith("file://")) {
    try {
      return fileURLToPath(urlOrPath);
    } catch {
      return urlOrPath;
    }
  }
  return urlOrPath;
}

/**
 * Reads ±radius lines around a 1-based line number from disk if readable.
 * Caps individual line text at 240 chars so minified bundles never blow up context.
 */
export function readSourceSnippet(
  filePath: string | undefined,
  line1Based: number | undefined,
  radius = 4,
): SourceContextSnippet | undefined {
  const normalized = normalizeFileUrlOrPath(filePath);
  if (!normalized || !line1Based || line1Based < 1) {
    return undefined;
  }
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) {
      return undefined;
    }
    const raw = fs.readFileSync(normalized, "utf8");
    const allLines = raw.split(/\r?\n/);
    if (line1Based > allLines.length) {
      return undefined;
    }

    const startLine = Math.max(1, line1Based - radius);
    const endLine = Math.min(allLines.length, line1Based + radius);
    const lines: SourceContextLine[] = [];
    for (let ln = startLine; ln <= endLine; ln++) {
      const text = allLines[ln - 1] ?? "";
      lines.push({
        line: ln,
        text: text.length > 240 ? `${text.slice(0, 237)}...` : text,
        isCurrent: ln === line1Based,
      });
    }
    return {
      file: normalized,
      startLine,
      endLine,
      currentLine: line1Based,
      lines,
    };
  } catch {
    return undefined;
  }
}

export function formatDisplayPath(filePath: string | undefined, cwd: string): string {
  if (!filePath) {
    return "<unknown>";
  }
  const normalized = normalizeFileUrlOrPath(filePath) ?? filePath;
  const rel = path.relative(cwd, normalized);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel;
  }
  return normalized;
}
