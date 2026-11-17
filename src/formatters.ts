/**
 * Crisp, token-efficient plain-text formatters for LLM tool results + TUI previews.
 */

import type {
  AdapterDoctorEntry,
  DebugDisassembledInstruction,
  DebugEvaluateResult,
  DebugMemoryReadResult,
  DebugScope,
  DebugStackFrame,
  DebugVariable,
  ProbeResult,
  SessionSummary,
  SourceContextSnippet,
  StopSnapshot,
  VerifiedBreakpoint,
} from "./types.ts";
import { formatDisplayPath } from "./utils/source-context.ts";

export function renderSourceSnippet(snippet: SourceContextSnippet | undefined): string {
  if (!snippet || snippet.lines.length === 0) {
    return "";
  }
  const width = String(snippet.endLine).length;
  return snippet.lines
    .map((ln) => {
      const marker = ln.isCurrent ? ">" : " ";
      const num = String(ln.line).padStart(width, " ");
      return `${marker} ${num} | ${ln.text}`;
    })
    .join("\n");
}

export function formatVariablesTree(vars: DebugVariable[], indent = "  "): string[] {
  const lines: string[] = [];
  for (const v of vars) {
    const typeTag = v.type ? ` (${v.type})` : "";
    lines.push(`${indent}${v.name}${typeTag} = ${v.value}`);
    if (v.children && v.children.length > 0) {
      lines.push(...formatVariablesTree(v.children.slice(0, 20), `${indent}  `));
      if (v.children.length > 20) {
        lines.push(`${indent}  ... (${v.children.length - 20} more properties)`);
      }
    }
  }
  return lines;
}

export function formatStopSnapshot(snapshot: StopSnapshot, cwd: string): string {
  const lines: string[] = [];
  const header = `Session ${snapshot.sessionId} [${snapshot.adapter}, ${snapshot.mode}] — state: ${snapshot.state}`;
  lines.push(header);

  if (snapshot.state === "terminated") {
    lines.push(`Process exited with code: ${String(snapshot.exitCode ?? 0)}`);
    if (snapshot.recentOutput?.trim()) {
      lines.push("", "Program Output:", snapshot.recentOutput.trimEnd());
    }
    return lines.join("\n");
  }

  if (snapshot.state === "running" || snapshot.state === "starting") {
    lines.push(
      "Target is running (not paused). Trigger the code path to hit a breakpoint, or call debug_session with action='pause' or action='status' (waitForStop=true).",
    );
    if (snapshot.recentOutput?.trim()) {
      lines.push("", "Recent Output:", snapshot.recentOutput.trimEnd());
    }
    return lines.join("\n");
  }

  const reason = snapshot.stopped?.reason ?? "paused";
  const desc = snapshot.stopped?.description ? ` — ${snapshot.stopped.description}` : "";
  lines.push(`Stopped reason: ${reason}${desc} (thread ${String(snapshot.stopped?.threadId ?? 1)})`);

  if (snapshot.stopped?.exception) {
    const ex = snapshot.stopped.exception;
    lines.push(`Exception [${ex.exceptionId}]: ${ex.description ?? ex.details?.message ?? ""}`);
    if (ex.details?.stackTrace) {
      lines.push(ex.details.stackTrace.trimEnd());
    }
  }

  if (snapshot.location) {
    const rel = formatDisplayPath(snapshot.location.file, cwd);
    lines.push("", `Location: ${rel}:${snapshot.location.line} in ${snapshot.location.functionName}`);
    const rendered = renderSourceSnippet(snapshot.location.snippet);
    if (rendered) {
      lines.push(rendered);
    }
  }

  if (snapshot.stack && snapshot.stack.length > 0) {
    lines.push("", "Call Stack:");
    for (const f of snapshot.stack.slice(0, 10)) {
      const loc = f.source?.path ? `${formatDisplayPath(f.source.path, cwd)}:${f.line}` : "<internal>";
      lines.push(`  #${f.id} ${f.name} at ${loc}`);
    }
  }

  if (snapshot.locals && snapshot.locals.length > 0) {
    lines.push("", "Locals:");
    lines.push(...formatVariablesTree(snapshot.locals));
  }

  if (snapshot.recentOutput?.trim()) {
    lines.push("", "Recent Output:", snapshot.recentOutput.trimEnd());
  }

  return lines.join("\n");
}

function breakpointStatusLabel(staged: boolean, verified: boolean): string {
  if (staged) {
    return "staged";
  }
  return verified ? "verified" : "unverified";
}

export function formatBreakpointsReport(opts: {
  staged: boolean;
  sessionId?: string;
  breakpoints: VerifiedBreakpoint[];
  cwd: string;
}): string {
  const prefix = opts.staged
    ? "Staged breakpoints (will bind on next launch/attach):"
    : `Breakpoints in session ${opts.sessionId ?? ""}:`;
  if (opts.breakpoints.length === 0) {
    return `${prefix} (none)`;
  }
  const lines = [prefix];
  for (const bp of opts.breakpoints) {
    const status = breakpointStatusLabel(opts.staged, bp.verified);
    const rel = formatDisplayPath(bp.file, opts.cwd);
    const moved = bp.requestedLine === bp.line ? "" : ` (requested L${bp.requestedLine})`;
    const cond = bp.condition ? ` [if ${bp.condition}]` : "";
    const log = bp.logMessage ? ` [log ${JSON.stringify(bp.logMessage)}]` : "";
    const msg = bp.message && !opts.staged ? ` — ${bp.message}` : "";
    lines.push(`  - ${rel}:${bp.line}${moved} (${status})${cond}${log}${msg}`);
  }
  return lines.join("\n");
}

export function formatScopesVariables(
  sessionId: string,
  frameId: number | undefined,
  scopes: Array<{ scope: DebugScope; variables: DebugVariable[] }>,
): string {
  const frameTag = frameId === undefined ? "" : ` (frame #${frameId})`;
  const lines = [`Variables for session ${sessionId}${frameTag}:`];
  if (scopes.length === 0) {
    lines.push("  (no variables in scope)");
    return lines.join("\n");
  }
  for (const { scope, variables } of scopes) {
    lines.push(`[${scope.name} (ref=${scope.variablesReference})]`);
    if (variables.length === 0) {
      lines.push("  (empty)");
    } else {
      lines.push(...formatVariablesTree(variables));
    }
  }
  return lines.join("\n");
}

export function formatStackTrace(
  sessionId: string,
  threadId: number,
  frames: DebugStackFrame[],
  cwd: string,
  snippet?: SourceContextSnippet,
): string {
  const lines = [`Stack trace for session ${sessionId} (thread ${threadId}):`];
  for (const f of frames) {
    const loc = f.source?.path ? `${formatDisplayPath(f.source.path, cwd)}:${f.line}:${f.column}` : "<internal>";
    lines.push(`  #${f.id} ${f.name} — ${loc}`);
  }
  const rendered = renderSourceSnippet(snippet);
  if (rendered) {
    lines.push("", "Top Frame Source:", rendered);
  }
  return lines.join("\n");
}

export function formatEvaluation(sessionId: string, ev: DebugEvaluateResult): string {
  if (ev.error) {
    return `[${sessionId}] ${ev.expression} threw: ${ev.error}`;
  }
  const typeTag = ev.type ? ` (${ev.type})` : "";
  const lines = [`[${sessionId}] ${ev.expression}${typeTag} => ${ev.result}`];
  if (ev.children && ev.children.length > 0) {
    lines.push(...formatVariablesTree(ev.children));
  }
  return lines.join("\n");
}

function describeSessionTarget(s: SessionSummary): string {
  if (s.program) {
    return s.program;
  }
  if (s.pid !== undefined) {
    return `pid:${s.pid}`;
  }
  return `${s.host ?? "127.0.0.1"}:${String(s.port ?? "")}`;
}

export function formatSessionList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return "No active debug sessions.";
  }
  const lines = ["Active debug sessions:"];
  for (const s of sessions) {
    const star = s.active ? "* " : "  ";
    const target = describeSessionTarget(s);
    const reason = s.stoppedReason ? ` (${s.stoppedReason})` : "";
    lines.push(`${star}${s.id} [${s.adapter}, ${s.mode}] ${s.state}${reason} — ${target} (${s.breakpointCount} bp)`);
  }
  return lines.join("\n");
}

export function formatDoctorReport(entries: AdapterDoctorEntry[]): string {
  const lines = ["pi-debugger Adapter Doctor:"];
  for (const e of entries) {
    const langs = e.languages.length > 0 ? ` [${e.languages.join(", ")}]` : "";
    if (e.available) {
      const detail = e.notes ?? e.resolvedBinary ?? e.transport;
      lines.push(`  [READY]   ${e.name}${langs} — ${detail}`);
    } else {
      lines.push(`  [MISSING] ${e.name}${langs} — ${e.installHint ?? "Not found on PATH"}`);
    }
  }
  return lines.join("\n");
}

function describeProbeStatus(res: ProbeResult): string {
  if (res.timedOut) {
    return "TIMED_OUT";
  }
  if (res.completed) {
    return `COMPLETED (exit=${String(res.exitCode ?? 0)})`;
  }
  return "STOPPED";
}

export function formatProbeResult(res: ProbeResult): string {
  const status = describeProbeStatus(res);
  const lines = [
    `Probe ${res.program} [${res.adapter}] — ${status} in ${res.durationMs}ms (${res.hits.length} hit${res.hits.length === 1 ? "" : "s"})`,
  ];

  for (const hit of res.hits) {
    const loc = hit.file && hit.line ? `${hit.file}:${hit.line}` : "<unknown>";
    lines.push("", `--- Hit #${hit.hitIndex} (${hit.reason}) at ${loc} in ${hit.functionName ?? "<top>"} ---`);
    if (hit.exception) {
      lines.push(`Exception [${hit.exception.exceptionId}]: ${hit.exception.description ?? ""}`);
    }
    const rendered = renderSourceSnippet(hit.snippet);
    if (rendered) {
      lines.push(rendered);
    }
    if (hit.evaluations.length > 0) {
      lines.push("Evaluations:");
      for (const ev of hit.evaluations) {
        if (ev.error) {
          lines.push(`  ${ev.expression} => ERROR: ${ev.error}`);
        } else {
          lines.push(`  ${ev.expression} => ${ev.result}`);
          if (ev.children && ev.children.length > 0) {
            lines.push(...formatVariablesTree(ev.children, "    "));
          }
        }
      }
    }
    if (hit.locals.length > 0) {
      lines.push("Locals:");
      lines.push(...formatVariablesTree(hit.locals));
    }
  }

  if (res.stdout.trim()) {
    lines.push("", "Stdout:", res.stdout.trimEnd());
  }
  if (res.stderr.trim()) {
    lines.push("", "Stderr:", res.stderr.trimEnd());
  }
  return lines.join("\n");
}

export function formatDisassembly(sessionId: string, instructions: DebugDisassembledInstruction[]): string {
  const lines = [`Disassembly for session ${sessionId} (${instructions.length} instructions):`];
  for (const inst of instructions) {
    const sym = inst.symbol ? ` <${inst.symbol}>` : "";
    const bytes = inst.instructionBytes ? ` [${inst.instructionBytes}]` : "";
    lines.push(`  ${inst.address}${sym}${bytes}: ${inst.instruction}`);
  }
  return lines.join("\n");
}

export function formatMemoryRead(sessionId: string, mem: DebugMemoryReadResult): string {
  const buf = Buffer.from(mem.dataBase64, "base64");
  const lines = [`Memory at ${mem.address} (${mem.bytesRead} bytes, session ${sessionId}):`];
  for (let offset = 0; offset < buf.length; offset += 16) {
    const slice = buf.subarray(offset, offset + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...slice].map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`  +${offset.toString(16).padStart(4, "0")}: ${hex.padEnd(47, " ")}  |${ascii}|`);
  }
  return lines.join("\n");
}
