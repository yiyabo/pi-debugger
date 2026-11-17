import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { runAdapterDoctor } from "../src/adapters/discovery.ts";
import {
  formatBreakpointsReport,
  formatDisassembly,
  formatDoctorReport,
  formatEvaluation,
  formatMemoryRead,
  formatProbeResult,
  formatScopesVariables,
  formatSessionList,
  formatStackTrace,
  formatStopSnapshot,
  renderSourceSnippet,
} from "../src/formatters.ts";
import { DebugSessionManager } from "../src/session-manager.ts";
import type { InlineBreakpointInput, ProbeBreakpointInput } from "../src/types.ts";
import { formatDisplayPath, readSourceSnippet, resolveToolPath } from "../src/utils/source-context.ts";

function stringEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  options?: { description?: string },
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description ? { description: options.description } : {}),
  });
}
const DEBUGGER_ACTIONS = [
  "doctor",
  "sessions",
  "switch",
  "status",
  "launch",
  "attach",
  "disconnect",
  "breakpoint",
  "clear_breakpoints",
  "list_breakpoints",
  "continue",
  "pause",
  "step_over",
  "step_in",
  "step_out",
  "threads",
  "stack",
  "variables",
  "evaluate",
  "source",
  "output",
  "disassemble",
  "memory",
  "custom",
] as const;

const InlineBreakpointSchema = Type.Object({
  file: Type.Optional(Type.String({ description: "Source file path (defaults to top-level file or launched program)." })),
  line: Type.Integer({ minimum: 1, description: "1-based source line number." }),
  column: Type.Optional(Type.Integer({ minimum: 1, description: "Optional 1-based column." })),
  condition: Type.Optional(Type.String({ description: "Break only when this boolean expression is truthy." })),
  hit_condition: Type.Optional(Type.String({ description: "Hit count condition (e.g. '5' or '>=10')." })),
  log_message: Type.Optional(Type.String({ description: "Logpoint message template (logs without pausing when supported)." })),
});

const FunctionBreakpointSchema = Type.Object({
  name: Type.String({ description: "Function or symbol name to break on." }),
  condition: Type.Optional(Type.String({ description: "Optional boolean condition." })),
});

const DebuggerParamsSchema = Type.Object({
  action: stringEnum(DEBUGGER_ACTIONS, {
    description:
      "Debugger operation: doctor | sessions | switch | status | launch | attach | disconnect | breakpoint | clear_breakpoints | list_breakpoints | continue | pause | step_over | step_in | step_out | threads | stack | variables | evaluate | source | output | disassemble | memory | custom.",
  }),
  session_id: Type.Optional(
    Type.String({ description: "Target session id (e.g. 's1'). Defaults to the active session." }),
  ),
  name: Type.Optional(Type.String({ description: "Optional human-readable label when launching or attaching a session." })),
  program: Type.Optional(
    Type.String({ description: "Executable or script path for launch (and optional binary path for native attach)." }),
  ),
  args: Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments passed to the debuggee." })),
  cwd: Type.Optional(Type.String({ description: "Working directory override (defaults to current workspace cwd)." })),
  adapter: Type.Optional(
    Type.String({
      description:
        "Adapter override: node | debugpy | dlv | codelldb | lldb-dap | gdb | netcoredbg | rdbg (auto-detected when omitted).",
    }),
  ),
  python: Type.Optional(
    Type.String({ description: "Target Python interpreter path when debugging Python scripts with debugpy." }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: "Extra environment variables for launched debuggee." }),
  ),
  pid: Type.Optional(Type.Integer({ minimum: 1, description: "Target process ID for live attach." })),
  host: Type.Optional(Type.String({ description: "Target host for TCP/WebSocket attach (default 127.0.0.1)." })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "Target port for attach (e.g. debugpy/inspect/dlv)." })),
  stop_on_entry: Type.Optional(Type.Boolean({ description: "Pause on the very first executable statement." })),
  break_on_exceptions: Type.Optional(
    stringEnum(["none", "uncaught", "all"] as const, {
      description: "Exception breakpoint policy (default: uncaught on launch).",
    }),
  ),
  file: Type.Optional(Type.String({ description: "Source file path for breakpoint or source actions." })),
  lines: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      description: "1-based line numbers for breakpoint action (pass [] to clear file breakpoints).",
    }),
  ),
  line: Type.Optional(Type.Integer({ minimum: 1, description: "Single 1-based line number for breakpoint or source." })),
  breakpoints: Type.Optional(
    Type.Array(InlineBreakpointSchema, {
      description: "Rich breakpoints (supports conditions, hit counts, logpoints, or pre-launch inline breakpoints).",
    }),
  ),
  function_breakpoints: Type.Optional(
    Type.Array(FunctionBreakpointSchema, { description: "Function/symbol breakpoints." }),
  ),
  thread_id: Type.Optional(Type.Integer({ minimum: 1, description: "Thread ID override." })),
  frame_id: Type.Optional(Type.Integer({ minimum: 0, description: "Stack frame ID for variables or evaluate." })),
  variables_reference: Type.Optional(
    Type.Integer({ minimum: 1, description: "Expand child properties of a structured variable." }),
  ),
  scope_filter: Type.Optional(
    Type.String({ description: "Case-insensitive substring filter on scope names (e.g. 'local')." }),
  ),
  max_depth: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 4, description: "Structured variable expansion depth (default 1)." }),
  ),
  levels: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Max stack frames to fetch (default 20)." })),
  expression: Type.Optional(Type.String({ description: "Expression to evaluate in the paused frame or global context." })),
  eval_context: Type.Optional(
    stringEnum(["watch", "repl", "hover"] as const, { description: "Evaluation context hint." }),
  ),
  context_lines: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 60, description: "Context lines before/after target line in source action." }),
  ),
  tail_lines: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 500, description: "Number of recent debuggee output lines to read." }),
  ),
  output_category: Type.Optional(
    stringEnum(["all", "stdout", "stderr"] as const, { description: "Filter debuggee output stream." }),
  ),
  memory_reference: Type.Optional(Type.String({ description: "Memory reference address (e.g. '0x100004000') for disassemble or memory." })),
  instruction_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Instructions to disassemble (default 32)." })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096, description: "Bytes of memory to read (default 128)." })),
  offset: Type.Optional(Type.Integer({ description: "Byte or instruction offset from memory_reference." })),
  dap_command: Type.Optional(Type.String({ description: "Raw DAP request command name for action='custom'." })),
  dap_args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Raw DAP request arguments for action='custom'." })),
  launch_args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Extra adapter-specific DAP launch arguments." }),
  ),
  attach_args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Extra adapter-specific DAP attach arguments." }),
  ),
  wait_for_stop: Type.Optional(
    Type.Boolean({ description: "Wait until debuggee pauses or exits before returning (default true)." }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({ minimum: 250, maximum: 120_000, description: "Wait timeout in milliseconds (default 15000)." }),
  ),
  terminate_debuggee: Type.Optional(
    Type.Boolean({ description: "Whether disconnect should terminate the debuggee (defaults true for launch, false for attach)." }),
  ),
  all: Type.Optional(Type.Boolean({ description: "Disconnect all active sessions when action='disconnect'." })),
});

type DebuggerParams = Static<typeof DebuggerParamsSchema>;

const ProbeBreakpointSchema = Type.Object({
  file: Type.Optional(Type.String({ description: "Source file path (defaults to launched program)." })),
  line: Type.Integer({ minimum: 1, description: "1-based line number to capture." }),
  condition: Type.Optional(Type.String({ description: "Optional boolean condition." })),
  hit_condition: Type.Optional(Type.String({ description: "Optional hit-count condition." })),
  watches: Type.Optional(Type.Array(Type.String(), { description: "Expressions to evaluate specifically at this breakpoint." })),
});

const DebugProbeParamsSchema = Type.Object({
  program: Type.String({ description: "Script or binary to launch and probe." }),
  args: Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments passed to the program." })),
  cwd: Type.Optional(Type.String({ description: "Working directory override." })),
  adapter: Type.Optional(Type.String({ description: "Optional adapter override (auto-detected by default)." })),
  python: Type.Optional(Type.String({ description: "Optional Python interpreter override." })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables." })),
  file: Type.Optional(Type.String({ description: "Source file for single-breakpoint shorthand (defaults to program)." })),
  line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line number for single-breakpoint shorthand." })),
  condition: Type.Optional(Type.String({ description: "Condition for single-breakpoint shorthand." })),
  hit_condition: Type.Optional(Type.String({ description: "Hit-count condition for single-breakpoint shorthand." })),
  breakpoints: Type.Optional(
    Type.Array(ProbeBreakpointSchema, { description: "Multiple breakpoints to capture during the run." }),
  ),
  watches: Type.Optional(
    Type.Array(Type.String(), { description: "Expressions to evaluate every time a probe breakpoint or exception pauses." }),
  ),
  stop_on_entry: Type.Optional(Type.Boolean({ description: "Capture state at program entry even without breakpoints." })),
  break_on_exceptions: Type.Optional(
    stringEnum(["none", "uncaught", "all"] as const, {
      description: "Capture state on uncaught/all exceptions (default: uncaught).",
    }),
  ),
  max_hits: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 25, description: "Maximum stops to capture before terminating cleanly (default: number of breakpoints or 1)." }),
  ),
  max_depth: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 3, description: "Nested object expansion depth for locals/watches (default 1)." }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({ minimum: 500, maximum: 120_000, description: "Total probe wall-clock timeout in milliseconds (default 20000)." }),
  ),
});

type DebugProbeParams = Static<typeof DebugProbeParamsSchema>;

interface DebuggerToolDetails {
  ok: boolean;
  action: string;
  sessionId?: string;
  state?: string;
  adapter?: string;
  summary?: string;
}

function okResult(text: string, details: DebuggerToolDetails): AgentToolResult<DebuggerToolDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function errorResult(message: string, action: string, sessionId?: string): AgentToolResult<DebuggerToolDetails> {
  return {
    content: [{ type: "text", text: `Debugger error (${action}): ${message}` }],
    details: {
      ok: false,
      action,
      sessionId,
      summary: message,
    },
    isError: true,
  };
}

function toInlineBreakpoints(
  params: Pick<DebuggerParams, "file" | "line" | "lines" | "breakpoints">,
): InlineBreakpointInput[] | undefined {
  const out: InlineBreakpointInput[] = [];
  if (params.breakpoints && params.breakpoints.length > 0) {
    for (const bp of params.breakpoints) {
      out.push({
        file: bp.file ?? params.file,
        line: bp.line,
        column: bp.column,
        condition: bp.condition,
        hitCondition: bp.hit_condition,
        logMessage: bp.log_message,
      });
    }
  }
  if (params.lines && params.lines.length > 0) {
    for (const ln of params.lines) {
      out.push({ file: params.file, line: ln });
    }
  } else if (typeof params.line === "number") {
    out.push({ file: params.file, line: params.line });
  }
  return out.length > 0 ? out : undefined;
}

function renderStatusFooter(manager: DebugSessionManager, theme: Theme): string | undefined {
  const sessions = manager.listSessions();
  if (sessions.length === 0) {
    const staged = manager.listBreakpoints();
    if (staged.staged && staged.breakpoints.length > 0) {
      return theme.fg("muted", `debug: ${staged.breakpoints.length} staged bp`);
    }
    return undefined;
  }

  const parts = sessions.map((s) => {
    const marker = s.active ? "*" : "";
    if (s.state === "stopped") {
      return theme.fg("warning", `${s.id}${marker}:stopped(${s.stoppedReason ?? "pause"})`);
    }
    if (s.state === "running") {
      return theme.fg("accent", `${s.id}${marker}:running`);
    }
    return theme.fg("muted", `${s.id}${marker}:${s.state}`);
  });
  return `${theme.fg("accent", "🐞")} ${parts.join(theme.fg("dim", " · "))}`;
}

function syncUiStatus(manager: DebugSessionManager, ctx: ExtensionContext | undefined): void {
  if (!ctx || ctx.mode !== "tui") {
    return;
  }
  ctx.ui.setStatus("pi-debugger", renderStatusFooter(manager, ctx.ui.theme));
}

function renderCollapsedLines(text: string, maxLines: number, theme: Theme, width: number): string {
  const lines = text.split("\n");
  const visible = lines.slice(0, maxLines).map((line) => truncateToWidth(line, Math.max(20, width)));
  if (lines.length > maxLines) {
    visible.push(theme.fg("muted", `… (${lines.length - maxLines} more lines — expand tool output to view all)`));
  }
  return visible.join("\n");
}

export default function piDebuggerExtension(pi: ExtensionAPI): void {
  const manager = new DebugSessionManager();
  let lastCtx: ExtensionContext | undefined;

  manager.onChange(() => {
    syncUiStatus(manager, lastCtx);
  });

  pi.on("session_start", async (event, ctx) => {
    lastCtx = ctx;
    if (event.reason === "new" || event.reason === "resume") {
      await manager.disposeAll();
    }
    syncUiStatus(manager, ctx);
  });

  pi.on("session_shutdown", async () => {
    await manager.disposeAll();
    if (lastCtx && lastCtx.mode === "tui") {
      lastCtx.ui.setStatus("pi-debugger", undefined);
    }
  });

  pi.registerTool({
    name: "debug_probe",
    label: "Debug Probe",
    description:
      "One-shot runtime probe: launches a program under a real debugger, captures stack frames, local variables, source context, and watch expressions at breakpoints or uncaught exceptions, then automatically terminates and cleans up all child processes.",
    promptSnippet:
      "Capture real runtime locals, watch expressions, and stack traces at specific lines or uncaught exceptions in one self-cleaning run",
    promptGuidelines: [
      "Prefer `debug_probe` over temporary print/console.log edits when you want to inspect runtime variable values, loop iterations, or uncaught exception state at known lines.",
      "Use `debugger` instead of `debug_probe` only when you need multi-step interactive stepping (`step_over`/`step_in`), live `attach` to an already-running PID/port, or state mutation across pauses.",
    ],
    parameters: DebugProbeParamsSchema,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    async execute(_toolCallId, params: DebugProbeParams, signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const workCwd = params.cwd ? resolveToolPath(params.cwd, ctx.cwd) : ctx.cwd;
      try {
        const probeBps: ProbeBreakpointInput[] = [];
        if (params.breakpoints && params.breakpoints.length > 0) {
          for (const bp of params.breakpoints) {
            probeBps.push({
              file: bp.file,
              line: bp.line,
              condition: bp.condition,
              hitCondition: bp.hit_condition,
              expressions: bp.watches,
            });
          }
        }
        if (typeof params.line === "number") {
          probeBps.push({
            file: params.file,
            line: params.line,
            condition: params.condition,
            hitCondition: params.hit_condition,
          });
        }

        const res = await manager.runProbe(
          {
            cwd: workCwd,
            program: params.program,
            args: params.args,
            adapter: params.adapter,
            pythonPath: params.python,
            env: params.env,
            stopOnEntry: params.stop_on_entry,
            breakpoints: probeBps.length > 0 ? probeBps : undefined,
            breakOnExceptions: params.break_on_exceptions,
            expressions: params.watches,
            maxHits: params.max_hits,
            maxDepth: params.max_depth,
            timeoutMs: params.timeout_ms,
          },
          signal,
        );

        const text = formatProbeResult(res);
        return okResult(text, {
          ok: true,
          action: "probe",
          adapter: res.adapter,
          state: res.timedOut ? "timeout" : "completed",
          summary: `${res.hits.length} hit(s) via ${res.adapter}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg, "probe");
      }
    },
    renderCall(args, theme) {
      const target = args.line ? `${args.program}:${args.line}` : args.program;
      const watches = args.watches && args.watches.length > 0 ? ` watches=[${args.watches.join(", ")}]` : "";
      const line = `${theme.fg("accent", theme.bold("debug_probe"))} ${theme.fg("text", target)}${theme.fg("muted", watches)}`;
      return new Text(line, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Running runtime probe…"), 0, 0);
      }
      const firstBlock = result.content[0];
      const rawText = firstBlock && firstBlock.type === "text" ? firstBlock.text : "";
      if (result.isError) {
        return new Text(theme.fg("error", rawText), 0, 0);
      }
      if (expanded) {
        return new Text(rawText, 0, 0);
      }
      return new Text(renderCollapsedLines(rawText, 12, theme, 110 - context.outputPad), 0, 0);
    },
  });

  pi.registerTool({
    name: "debugger",
    label: "Debugger",
    description:
      "Interactive multi-session runtime debugger (DAP + built-in Node/TS V8 Inspector). Supports zero-config launch, live PID/port attach, pre-launch staged breakpoints, conditional breakpoints/logpoints, stepping, stack/variable inspection, watch evaluation, disassembly, and memory reads.",
    promptSnippet:
      "Launch or attach interactive debug sessions, set conditional breakpoints, step execution, and inspect frames/variables/memory",
    promptGuidelines: [
      "Call `debugger` with `action: \"doctor\"` if you are unsure which language debuggers (`node`, `debugpy`, `dlv`, `codelldb`, `lldb-dap`, `gdb`) are available on the machine.",
      "With `debugger`, you can stage breakpoints via `action: \"breakpoint\"` before `launch`/`attach`, or pass `breakpoints` directly inside `launch`/`attach`.",
      "Always call `debugger` with `action: \"disconnect\"` when finished with an interactive debug session so background processes are released.",
    ],
    parameters: DebuggerParamsSchema,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    async execute(_toolCallId, params: DebuggerParams, signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const workCwd = params.cwd ? resolveToolPath(params.cwd, ctx.cwd) : ctx.cwd;

      try {
        switch (params.action) {
          case "doctor": {
            const entries = runAdapterDoctor(workCwd);
            const readyCount = entries.filter((e) => e.available).length;
            return okResult(formatDoctorReport(entries), {
              ok: true,
              action: "doctor",
              summary: `${readyCount}/${entries.length} adapters available`,
            });
          }

          case "sessions": {
            const sessions = manager.listSessions();
            return okResult(formatSessionList(sessions), {
              ok: true,
              action: "sessions",
              summary: `${sessions.length} active session(s)`,
            });
          }

          case "switch": {
            if (!params.session_id) {
              return errorResult("'session_id' is required for action='switch'.", "switch");
            }
            const summary = manager.switchSession(params.session_id);
            syncUiStatus(manager, ctx);
            return okResult(
              `Switched active debug session to [${summary.id}] (${summary.adapter}, state=${summary.state}).`,
              {
                ok: true,
                action: "switch",
                sessionId: summary.id,
                adapter: summary.adapter,
                state: summary.state,
              },
            );
          }

          case "status": {
            const statusRes = await manager.status(
              {
                sessionId: params.session_id,
                waitForStop: params.wait_for_stop,
                waitTimeoutMs: params.timeout_ms,
              },
              signal,
            );
            if (!statusRes.snapshot) {
              return okResult(formatSessionList(statusRes.allSessions), {
                ok: true,
                action: "status",
                summary: `${statusRes.allSessions.length} active session(s)`,
              });
            }
            const snap = statusRes.snapshot;
            return okResult(formatStopSnapshot(snap, workCwd), {
              ok: true,
              action: "status",
              sessionId: snap.sessionId,
              adapter: snap.adapter,
              state: snap.state,
            });
          }

          case "launch": {
            if (!params.program) {
              return errorResult("'program' is required for action='launch'.", "launch");
            }
            const inlineBps = toInlineBreakpoints(params);
            const launched = await manager.launch(
              {
                cwd: workCwd,
                program: params.program,
                args: params.args,
                adapter: params.adapter,
                pythonPath: params.python,
                env: params.env,
                stopOnEntry: params.stop_on_entry,
                breakpoints: inlineBps,
                functionBreakpoints: params.function_breakpoints,
                breakOnExceptions: params.break_on_exceptions,
                launchArgs: params.launch_args,
                waitForStop: params.wait_for_stop,
                waitTimeoutMs: params.timeout_ms,
                name: params.name,
              },
              signal,
            );
            syncUiStatus(manager, ctx);
            const snap = launched.snapshot;
            return okResult(formatStopSnapshot(snap, workCwd), {
              ok: true,
              action: "launch",
              sessionId: snap.sessionId,
              adapter: snap.adapter,
              state: snap.state,
            });
          }

          case "attach": {
            if (params.pid === undefined && params.port === undefined && !params.attach_args) {
              return errorResult(
                "Provide 'pid', 'port' (and optional 'host'), or 'attach_args' for action='attach'.",
                "attach",
              );
            }
            const inlineBps = toInlineBreakpoints(params);
            const attached = await manager.attach(
              {
                cwd: workCwd,
                adapter: params.adapter,
                pid: params.pid,
                host: params.host,
                port: params.port,
                program: params.program,
                breakpoints: inlineBps,
                functionBreakpoints: params.function_breakpoints,
                breakOnExceptions: params.break_on_exceptions,
                attachArgs: params.attach_args,
                waitForStop: params.wait_for_stop,
                waitTimeoutMs: params.timeout_ms,
                name: params.name,
              },
              signal,
            );
            syncUiStatus(manager, ctx);
            const snap = attached.snapshot;
            return okResult(formatStopSnapshot(snap, workCwd), {
              ok: true,
              action: "attach",
              sessionId: snap.sessionId,
              adapter: snap.adapter,
              state: snap.state,
            });
          }

          case "disconnect": {
            const { closedSessions } = await manager.disconnect(
              {
                sessionId: params.session_id,
                terminateDebuggee: params.terminate_debuggee,
                all: params.all,
              },
              signal,
            );
            syncUiStatus(manager, ctx);
            const label =
              closedSessions.length > 0
                ? `Disconnected session(s): ${closedSessions.join(", ")}.`
                : "No matching active debug sessions.";
            return okResult(label, {
              ok: true,
              action: "disconnect",
              summary: label,
            });
          }

          case "breakpoint": {
            const richBps = params.breakpoints?.map((bp) => ({
              file: bp.file ?? params.file,
              line: bp.line,
              column: bp.column,
              condition: bp.condition,
              hitCondition: bp.hit_condition,
              logMessage: bp.log_message,
            }));
            let lineList: number[] | undefined = params.lines;
            if (lineList === undefined && typeof params.line === "number") {
              lineList = [params.line];
            }

            const res = await manager.setBreakpoints(
              {
                cwd: workCwd,
                sessionId: params.session_id,
                file: params.file,
                lines: lineList,
                breakpoints: richBps,
                functionBreakpoints: params.function_breakpoints,
              },
              signal,
            );
            syncUiStatus(manager, ctx);
            return okResult(
              formatBreakpointsReport({
                staged: res.staged,
                sessionId: res.sessionId,
                breakpoints: res.verifiedBreakpoints,
                cwd: workCwd,
              }),
              {
                ok: true,
                action: "breakpoint",
                sessionId: res.sessionId,
                summary: `${res.verifiedBreakpoints.length} breakpoint(s)`,
              },
            );
          }

          case "clear_breakpoints": {
            const cleared = await manager.clearBreakpoints(params.session_id, signal);
            syncUiStatus(manager, ctx);
            return okResult(
              `Cleared breakpoints (${cleared.clearedFiles.length} file group(s)${params.session_id ? ` in [${params.session_id}]` : ""}).`,
              {
                ok: true,
                action: "clear_breakpoints",
                sessionId: params.session_id,
              },
            );
          }

          case "list_breakpoints": {
            const listed = manager.listBreakpoints(params.session_id);
            return okResult(
              formatBreakpointsReport({
                staged: listed.staged,
                sessionId: listed.sessionId,
                breakpoints: listed.breakpoints,
                cwd: workCwd,
              }),
              {
                ok: true,
                action: "list_breakpoints",
                sessionId: listed.sessionId,
              },
            );
          }

          case "continue": {
            const snap = await manager.continueExecution(
              {
                sessionId: params.session_id,
                threadId: params.thread_id,
                waitForStop: params.wait_for_stop,
                waitTimeoutMs: params.timeout_ms,
              },
              signal,
            );
            syncUiStatus(manager, ctx);
            return okResult(formatStopSnapshot(snap, workCwd), {
              ok: true,
              action: "continue",
              sessionId: snap.sessionId,
              state: snap.state,
            });
          }

          case "pause": {
            const snap = await manager.pauseExecution(
              {
                sessionId: params.session_id,
                threadId: params.thread_id,
                waitTimeoutMs: params.timeout_ms,
              },
              signal,
            );
            syncUiStatus(manager, ctx);
            return okResult(formatStopSnapshot(snap, workCwd), {
              ok: true,
              action: "pause",
              sessionId: snap.sessionId,
              state: snap.state,
            });
          }

          case "step_over":
          case "step_in":
          case "step_out": {
            let kind: "over" | "in" | "out" = "out";
            if (params.action === "step_over") {
              kind = "over";
            } else if (params.action === "step_in") {
              kind = "in";
            }
            const snap = await manager.step(
              kind,
              {
                sessionId: params.session_id,
                threadId: params.thread_id,
                waitTimeoutMs: params.timeout_ms,
              },
              signal,
            );
            syncUiStatus(manager, ctx);
            return okResult(formatStopSnapshot(snap, workCwd), {
              ok: true,
              action: params.action,
              sessionId: snap.sessionId,
              state: snap.state,
            });
          }

          case "threads": {
            const res = await manager.threads(params.session_id, signal);
            const lines = [`[${res.sessionId}] Threads (${res.threads.length}):`];
            for (const t of res.threads) {
              const marker = t.id === res.activeThreadId ? "*" : " ";
              lines.push(`  ${marker} #${t.id} ${t.name}`);
            }
            return okResult(lines.join("\n"), {
              ok: true,
              action: "threads",
              sessionId: res.sessionId,
            });
          }

          case "stack": {
            const res = await manager.stackTrace(
              {
                sessionId: params.session_id,
                threadId: params.thread_id,
                levels: params.levels,
              },
              signal,
            );
            const topSnippet =
              res.location?.file && res.location.line
                ? (readSourceSnippet(res.location.file, res.location.line, 3) ?? undefined)
                : undefined;
            return okResult(
              formatStackTrace(res.sessionId, res.threadId, res.frames, workCwd, topSnippet),
              {
                ok: true,
                action: "stack",
                sessionId: res.sessionId,
              },
            );
          }

          case "variables": {
            const res = await manager.variables(
              {
                sessionId: params.session_id,
                frameId: params.frame_id,
                variablesReference: params.variables_reference,
                scopeFilter: params.scope_filter,
                maxDepth: params.max_depth,
              },
              signal,
            );
            return okResult(formatScopesVariables(res.sessionId, res.frameId, res.scopes), {
              ok: true,
              action: "variables",
              sessionId: res.sessionId,
            });
          }

          case "evaluate": {
            if (!params.expression) {
              return errorResult("'expression' is required for action='evaluate'.", "evaluate", params.session_id);
            }
            const res = await manager.evaluate(
              {
                sessionId: params.session_id,
                expression: params.expression,
                frameId: params.frame_id,
                context: params.eval_context,
                maxDepth: params.max_depth,
              },
              signal,
            );
            return okResult(formatEvaluation(res.sessionId, res.evaluation), {
              ok: true,
              action: "evaluate",
              sessionId: res.sessionId,
            });
          }

          case "source": {
            let targetFile = params.file ? resolveToolPath(params.file, workCwd) : undefined;
            let targetLine = params.line;
            if (!targetFile || !targetLine) {
              const statusRes = await manager.status(
                { sessionId: params.session_id, waitForStop: false },
                signal,
              );
              const snap = statusRes.snapshot;
              if (!targetFile && snap?.location?.file) {
                targetFile = snap.location.file;
              }
              if (!targetLine && snap?.location?.line) {
                targetLine = snap.location.line;
              }
            }
            if (!targetFile || !targetLine) {
              return errorResult(
                "Provide 'file' and 'line', or pause at a frame with source info first.",
                "source",
                params.session_id,
              );
            }
            const snippet = readSourceSnippet(targetFile, targetLine, params.context_lines ?? 6);
            if (!snippet) {
              return errorResult(`Unable to read source file: ${targetFile}`, "source", params.session_id);
            }
            const header = `Source ${formatDisplayPath(targetFile, workCwd)}:${targetLine}`;
            return okResult(`${header}\n${renderSourceSnippet(snippet)}`, {
              ok: true,
              action: "source",
              sessionId: params.session_id,
            });
          }

          case "output": {
            const out = manager.getOutput({
              sessionId: params.session_id,
              tailLines: params.tail_lines ?? 80,
              category: params.output_category ?? "all",
            });
            const body = out.output.trim().length > 0 ? out.output.trimEnd() : "(no output captured yet)";
            return okResult(`[${out.sessionId}] Output (${params.output_category ?? "all"}):\n${body}`, {
              ok: true,
              action: "output",
              sessionId: out.sessionId,
            });
          }

          case "disassemble": {
            if (!params.memory_reference) {
              return errorResult(
                "'memory_reference' is required for action='disassemble'.",
                "disassemble",
                params.session_id,
              );
            }
            const res = await manager.disassemble(
              {
                sessionId: params.session_id,
                memoryReference: params.memory_reference,
                instructionCount: params.instruction_count,
                offset: params.offset,
              },
              signal,
            );
            return okResult(formatDisassembly(res.sessionId, res.instructions), {
              ok: true,
              action: "disassemble",
              sessionId: res.sessionId,
            });
          }

          case "memory": {
            if (!params.memory_reference) {
              return errorResult("'memory_reference' is required for action='memory'.", "memory", params.session_id);
            }
            const res = await manager.readMemory(
              {
                sessionId: params.session_id,
                memoryReference: params.memory_reference,
                count: params.count,
                offset: params.offset,
              },
              signal,
            );
            return okResult(formatMemoryRead(res.sessionId, res.memory), {
              ok: true,
              action: "memory",
              sessionId: res.sessionId,
            });
          }

          case "custom": {
            if (!params.dap_command) {
              return errorResult("'dap_command' is required for action='custom'.", "custom", params.session_id);
            }
            const res = await manager.customRequest(
              {
                sessionId: params.session_id,
                command: params.dap_command,
                args: params.dap_args,
              },
              signal,
            );
            return okResult(
              `[${res.sessionId}] DAP ${params.dap_command} response:\n${JSON.stringify(res.body, null, 2)}`,
              {
                ok: true,
                action: "custom",
                sessionId: res.sessionId,
              },
            );
          }
          default: {
            return errorResult(`Unsupported action: ${String(params.action)}`, String(params.action), params.session_id);
          }
        }
      } catch (err) {
        syncUiStatus(manager, ctx);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg, params.action, params.session_id);
      }
    },
    renderCall(args, theme) {
      const parts: string[] = [
        theme.fg("accent", theme.bold("debugger")),
        theme.fg("warning", args.action),
      ];
      if (args.session_id) {
        parts.push(theme.fg("muted", `[${args.session_id}]`));
      }
      if (args.program) {
        parts.push(theme.fg("text", args.program));
      } else if (args.file) {
        const loc = args.line ? `${args.file}:${args.line}` : args.file;
        parts.push(theme.fg("text", loc));
      } else if (args.expression) {
        parts.push(theme.fg("text", args.expression));
      } else if (args.pid !== undefined) {
        parts.push(theme.fg("text", `pid=${args.pid}`));
      } else if (args.port !== undefined) {
        parts.push(theme.fg("text", `${args.host ?? "127.0.0.1"}:${args.port}`));
      }
      return new Text(parts.join(" "), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Executing debugger command…"), 0, 0);
      }
      const firstBlock = result.content[0];
      const rawText = firstBlock && firstBlock.type === "text" ? firstBlock.text : "";
      if (result.isError) {
        return new Text(theme.fg("error", rawText), 0, 0);
      }
      if (expanded) {
        return new Text(rawText, 0, 0);
      }
      return new Text(renderCollapsedLines(rawText, 12, theme, 110 - context.outputPad), 0, 0);
    },
  });

  const handleSlashCommand = async (rawArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
    lastCtx = ctx;
    const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
    const sub = tokens[0] ?? "status";

    if (sub === "doctor") {
      const entries = runAdapterDoctor(ctx.cwd);
      const report = formatDoctorReport(entries);
      if (ctx.hasUI) {
        ctx.ui.notify(report, "info");
      }
      return;
    }

    if (sub === "stop" || sub === "disconnect") {
      const target = tokens[1];
      const { closedSessions } = await manager.disconnect(
        target && target !== "all" ? { sessionId: target } : { all: true },
      );
      syncUiStatus(manager, ctx);
      if (ctx.hasUI) {
        const msg =
          closedSessions.length > 0
            ? `Stopped debug session(s): ${closedSessions.join(", ")}`
            : "No active debug sessions to stop.";
        ctx.ui.notify(msg, "info");
      }
      return;
    }

    const sessions = manager.listSessions();
    const report = formatSessionList(sessions);
    if (ctx.hasUI) {
      ctx.ui.notify(report, "info");
    }
  };

  pi.registerCommand("dap", {
    description: "Inspect or control active DAP/Inspector debug sessions (/dap [status|doctor|stop [id|all]])",
    getArgumentCompletions(prefix) {
      const candidates = ["status", "sessions", "doctor", "stop", "stop all"];
      const filtered = candidates
        .filter((item) => item.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: handleSlashCommand,
  });
}
