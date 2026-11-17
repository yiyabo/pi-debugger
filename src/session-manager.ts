/**
 * Multi-session Debug Session Manager + One-Shot Probe Engine.
 */

import * as fs from "node:fs";
import type {
  DebugBackend,
  DebugBackendCallbacks,
  DebugDisassembledInstruction,
  DebugEvaluateResult,
  DebugExceptionInfo,
  DebugLaunchMode,
  DebugMemoryReadResult,
  DebugOutputEvent,
  DebugScope,
  DebugSessionState,
  DebugStackFrame,
  DebugStoppedEvent,
  DebugThread,
  DebugVariable,
  InlineBreakpointInput,
  ProbeHitSnapshot,
  ProbeOptions,
  ProbeResult,
  ResolvedAdapter,
  SessionSummary,
  SourceBreakpointSpec,
  StopSnapshot,
  VerifiedBreakpoint,
  VerifiedFunctionBreakpoint,
} from "./types.ts";
import { DapBackend } from "./adapters/dap-backend.ts";
import { selectAdapterForAttach, selectAdapterForLaunch } from "./adapters/discovery.ts";
import { NodeInspectorBackend } from "./adapters/node-inspector.ts";
import { formatDisplayPath, readSourceSnippet, resolveToolPath } from "./utils/source-context.ts";

const MAX_OUTPUT_CHUNKS = 400;
const MAX_OUTPUT_CHARS = 64_000;

function isRegisterScope(scope: DebugScope): boolean {
  if (scope.presentationHint === "registers") {
    return true;
  }
  return scope.name.trim().toLowerCase() === "registers";
}

function isNoisySnapshotScope(scope: DebugScope): boolean {
  if (scope.expensive || isRegisterScope(scope)) {
    return true;
  }
  const lower = scope.name.trim().toLowerCase();
  return lower === "global" || lower === "globals" || lower === "static" || lower === "statics";
}

export interface LaunchSessionOptions {
  cwd: string;
  program: string;
  args?: string[];
  adapter?: string;
  pythonPath?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  breakpoints?: InlineBreakpointInput[];
  functionBreakpoints?: Array<{ name: string; condition?: string }>;
  breakOnExceptions?: "none" | "uncaught" | "all";
  launchArgs?: Record<string, unknown>;
  waitForStop?: boolean;
  waitTimeoutMs?: number;
  name?: string;
}

export interface AttachSessionOptions {
  cwd: string;
  adapter?: string;
  pid?: number;
  host?: string;
  port?: number;
  program?: string;
  breakpoints?: InlineBreakpointInput[];
  functionBreakpoints?: Array<{ name: string; condition?: string }>;
  breakOnExceptions?: "none" | "uncaught" | "all";
  attachArgs?: Record<string, unknown>;
  waitForStop?: boolean;
  waitTimeoutMs?: number;
  name?: string;
}

interface ManagedSession {
  id: string;
  name?: string;
  mode: DebugLaunchMode;
  adapter: ResolvedAdapter;
  backend: DebugBackend;
  cwd: string;
  program?: string;
  pid?: number;
  host?: string;
  port?: number;
  state: DebugSessionState;
  activeThreadId?: number;
  activeFrameId?: number;
  stopped?: DebugStoppedEvent;
  exitCode?: number | null;
  breakpointsByFile: Map<string, VerifiedBreakpoint[]>;
  functionBreakpoints: VerifiedFunctionBreakpoint[];
  outputChunks: DebugOutputEvent[];
  outputCharCount: number;
  unreadOutputIndex: number;
  startedAt: number;
  stateWaiters: Set<() => void>;
}

function exceptionFiltersForPolicy(
  policy: "none" | "uncaught" | "all" | undefined,
  adapterName: string,
): string[] | undefined {
  if (!policy) {
    return undefined;
  }
  if (policy === "none") {
    return [];
  }
  if (adapterName === "debugpy") {
    return policy === "all" ? ["raised", "uncaught"] : ["uncaught"];
  }
  if (adapterName === "node") {
    return policy === "all" ? ["all"] : ["uncaught"];
  }
  return policy === "all" ? ["all", "uncaught"] : ["uncaught"];
}

export class DebugSessionManager {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #stagedBreakpoints = new Map<string, SourceBreakpointSpec[]>();
  readonly #stagedFunctionBreakpoints: Array<{ name: string; condition?: string }> = [];
  #activeSessionId?: string;
  #counter = 0;
  readonly #changeListeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  #notifyChange(): void {
    for (const fn of this.#changeListeners) {
      try {
        fn();
      } catch {
        // ignore UI listener errors
      }
    }
  }

  listSessions(): SessionSummary[] {
    return [...this.#sessions.values()].map((s) => this.#toSummary(s));
  }

  getActiveSessionSummary(): SessionSummary | undefined {
    if (!this.#activeSessionId) {
      return undefined;
    }
    const s = this.#sessions.get(this.#activeSessionId);
    return s ? this.#toSummary(s) : undefined;
  }

  switchSession(sessionId: string): SessionSummary {
    const s = this.#requireSession(sessionId);
    this.#activeSessionId = s.id;
    this.#notifyChange();
    return this.#toSummary(s);
  }

  async launch(opts: LaunchSessionOptions, signal?: AbortSignal): Promise<{
    session: SessionSummary;
    snapshot: StopSnapshot;
    verifiedBreakpoints: VerifiedBreakpoint[];
  }> {
    const resolvedProgram = resolveToolPath(opts.program, opts.cwd);
    if (!fs.existsSync(resolvedProgram)) {
      throw new Error(`Program not found: ${resolvedProgram}`);
    }

    const { adapter, launchOverrides } = selectAdapterForLaunch({
      program: resolvedProgram,
      cwd: opts.cwd,
      adapter: opts.adapter,
      pythonPath: opts.pythonPath,
    });

    const initialBreakpoints = this.#collectInitialBreakpoints(opts.cwd, resolvedProgram, opts.breakpoints);
    const initialFnBps = [
      ...this.#stagedFunctionBreakpoints.splice(0),
      ...(opts.functionBreakpoints ?? []),
    ];

    const id = `s${++this.#counter}`;
    const session = await this.#createManagedSession({
      id,
      name: opts.name,
      mode: "launch",
      adapter,
      cwd: opts.cwd,
      program: resolvedProgram,
      env: opts.env,
    });

    try {
      const filters = exceptionFiltersForPolicy(opts.breakOnExceptions, adapter.name);
      const { verifiedBreakpoints, verifiedFunctionBreakpoints } = await session.backend.startLaunch(
        {
          program: resolvedProgram,
          args: opts.args,
          cwd: opts.cwd,
          env: opts.env,
          stopOnEntry: opts.stopOnEntry,
          launchArgs: { ...launchOverrides, ...opts.launchArgs },
          initialBreakpoints,
          initialFunctionBreakpoints: initialFnBps,
          exceptionFilters: filters,
        },
        signal,
      );

      this.#storeVerifiedBreakpoints(session, verifiedBreakpoints);
      session.functionBreakpoints = verifiedFunctionBreakpoints;
      if (session.state === "starting") {
        session.state = "running";
      }
      this.#activeSessionId = session.id;
      this.#notifyChange();

      if (opts.waitForStop !== false) {
        await this.#waitForStopOrTermination(session, opts.waitTimeoutMs ?? 8_000, signal);
      }
      const snapshot = await this.buildSnapshot(session.id, { maxDepth: 1 }, signal);
      return {
        session: this.#toSummary(session),
        snapshot,
        verifiedBreakpoints,
      };
    } catch (err) {
      this.#sessions.delete(session.id);
      if (this.#activeSessionId === session.id) {
        this.#activeSessionId = [...this.#sessions.keys()].at(-1);
      }
      await session.backend.dispose();
      this.#notifyChange();
      throw err;
    }
  }

  async attach(opts: AttachSessionOptions, signal?: AbortSignal): Promise<{
    session: SessionSummary;
    snapshot: StopSnapshot;
    verifiedBreakpoints: VerifiedBreakpoint[];
  }> {
    if (opts.pid === undefined && opts.port === undefined) {
      throw new Error("attach requires either 'pid' (process ID) or 'port' (TCP/Inspector port)");
    }

    const resolvedProgram = opts.program ? resolveToolPath(opts.program, opts.cwd) : undefined;
    const adapter = selectAdapterForAttach({
      cwd: opts.cwd,
      adapter: opts.adapter,
      pid: opts.pid,
      host: opts.host,
      port: opts.port,
    });

    const initialBreakpoints = this.#collectInitialBreakpoints(opts.cwd, resolvedProgram, opts.breakpoints);
    const initialFnBps = [
      ...this.#stagedFunctionBreakpoints.splice(0),
      ...(opts.functionBreakpoints ?? []),
    ];

    const id = `s${++this.#counter}`;
    const session = await this.#createManagedSession({
      id,
      name: opts.name,
      mode: "attach",
      adapter,
      cwd: opts.cwd,
      program: resolvedProgram,
      pid: opts.pid,
      host: opts.host ?? "127.0.0.1",
      port: opts.port,
    });

    try {
      const filters = exceptionFiltersForPolicy(opts.breakOnExceptions, adapter.name);
      const { verifiedBreakpoints, verifiedFunctionBreakpoints } = await session.backend.startAttach(
        {
          cwd: opts.cwd,
          pid: opts.pid,
          host: opts.host,
          port: opts.port,
          program: resolvedProgram,
          attachArgs: opts.attachArgs,
          initialBreakpoints,
          initialFunctionBreakpoints: initialFnBps,
          exceptionFilters: filters,
        },
        signal,
      );

      this.#storeVerifiedBreakpoints(session, verifiedBreakpoints);
      session.functionBreakpoints = verifiedFunctionBreakpoints;
      if (session.state === "starting") {
        session.state = "running";
      }
      this.#activeSessionId = session.id;
      this.#notifyChange();

      if (opts.waitForStop !== false) {
        await this.#waitForStopOrTermination(session, opts.waitTimeoutMs ?? 3_500, signal);
      }
      const snapshot = await this.buildSnapshot(session.id, { maxDepth: 1 }, signal);
      return {
        session: this.#toSummary(session),
        snapshot,
        verifiedBreakpoints,
      };
    } catch (err) {
      this.#sessions.delete(session.id);
      if (this.#activeSessionId === session.id) {
        this.#activeSessionId = [...this.#sessions.keys()].at(-1);
      }
      await session.backend.dispose();
      this.#notifyChange();
      throw err;
    }
  }

  async setBreakpoints(
    opts: {
      cwd: string;
      sessionId?: string;
      file?: string;
      lines?: number[];
      breakpoints?: InlineBreakpointInput[];
      functionBreakpoints?: Array<{ name: string; condition?: string }>;
    },
    signal?: AbortSignal,
  ): Promise<{
    staged: boolean;
    sessionId?: string;
    verifiedBreakpoints: VerifiedBreakpoint[];
    verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[];
  }> {
    const active = opts.sessionId ? this.#requireSession(opts.sessionId) : this.#getActiveLiveSession();
    const defaultFile = opts.file ? resolveToolPath(opts.file, opts.cwd) : active?.program;
    const grouped = this.#groupBreakpointInputs(opts, defaultFile);

    if (!active) {
      return this.#stageBreakpoints(grouped, opts.functionBreakpoints);
    }

    const verifiedOut: VerifiedBreakpoint[] = [];
    for (const [filePath, specs] of grouped.entries()) {
      const verified = await active.backend.setSourceBreakpoints(filePath, specs, signal);
      if (specs.length === 0) {
        active.breakpointsByFile.delete(filePath);
      } else {
        active.breakpointsByFile.set(filePath, verified);
      }
      verifiedOut.push(...verified);
    }

    let verifiedFns = active.functionBreakpoints;
    if (opts.functionBreakpoints) {
      verifiedFns = await active.backend.setFunctionBreakpoints(opts.functionBreakpoints, signal);
      active.functionBreakpoints = verifiedFns;
    }

    this.#notifyChange();
    return {
      staged: false,
      sessionId: active.id,
      verifiedBreakpoints: verifiedOut,
      verifiedFunctionBreakpoints: verifiedFns,
    };
  }

  async clearBreakpoints(sessionId?: string, signal?: AbortSignal): Promise<{ clearedFiles: string[] }> {
    const active = sessionId ? this.#requireSession(sessionId) : this.#getActiveLiveSession();
    if (!active) {
      const files = [...this.#stagedBreakpoints.keys()];
      this.#stagedBreakpoints.clear();
      this.#stagedFunctionBreakpoints.length = 0;
      return { clearedFiles: files };
    }

    const clearedFiles = [...active.breakpointsByFile.keys()];
    for (const file of clearedFiles) {
      await active.backend.setSourceBreakpoints(file, [], signal);
    }
    active.breakpointsByFile.clear();
    if (active.functionBreakpoints.length > 0) {
      await active.backend.setFunctionBreakpoints([], signal);
      active.functionBreakpoints = [];
    }
    this.#notifyChange();
    return { clearedFiles };
  }

  listBreakpoints(sessionId?: string): {
    staged: boolean;
    sessionId?: string;
    breakpoints: VerifiedBreakpoint[];
    functionBreakpoints: VerifiedFunctionBreakpoint[];
  } {
    const active = sessionId ? this.#requireSession(sessionId) : this.#getActiveLiveSession();
    if (!active) {
      const bps: VerifiedBreakpoint[] = [];
      for (const [file, specs] of this.#stagedBreakpoints.entries()) {
        for (const s of specs) {
          bps.push({
            verified: false,
            file,
            line: s.line,
            requestedLine: s.line,
            condition: s.condition,
            logMessage: s.logMessage,
            message: "Staged for next launch/attach",
          });
        }
      }
      return {
        staged: true,
        breakpoints: bps,
        functionBreakpoints: this.#stagedFunctionBreakpoints.map((f) => ({
          name: f.name,
          verified: false,
          message: "Staged for next launch/attach",
        })),
      };
    }

    const bps: VerifiedBreakpoint[] = [];
    for (const list of active.breakpointsByFile.values()) {
      bps.push(...list);
    }
    return {
      staged: false,
      sessionId: active.id,
      breakpoints: bps,
      functionBreakpoints: active.functionBreakpoints,
    };
  }

  async continueExecution(
    opts: { sessionId?: string; threadId?: number; waitForStop?: boolean; waitTimeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<StopSnapshot> {
    const session = this.#requireLiveSession(opts.sessionId);
    const threadId = opts.threadId ?? session.activeThreadId;
    session.state = "running";
    session.stopped = undefined;
    session.activeFrameId = undefined;
    this.#notifyChange();

    await session.backend.continueExecution(threadId, signal);
    if (opts.waitForStop !== false) {
      await this.#waitForStopOrTermination(session, opts.waitTimeoutMs ?? 10_000, signal);
    }
    return this.buildSnapshot(session.id, { maxDepth: 1 }, signal);
  }

  async pauseExecution(
    opts: { sessionId?: string; threadId?: number; waitTimeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<StopSnapshot> {
    const session = this.#requireLiveSession(opts.sessionId);
    await session.backend.pauseExecution(opts.threadId ?? session.activeThreadId, signal);
    await this.#waitForStopOrTermination(session, opts.waitTimeoutMs ?? 4_000, signal);
    return this.buildSnapshot(session.id, { maxDepth: 1 }, signal);
  }

  async step(
    kind: "over" | "in" | "out",
    opts: { sessionId?: string; threadId?: number; waitTimeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<StopSnapshot> {
    const session = this.#requireStoppedSession(opts.sessionId);
    const threadId = opts.threadId ?? session.activeThreadId ?? 1;
    session.state = "running";
    session.stopped = undefined;
    session.activeFrameId = undefined;
    this.#notifyChange();

    if (kind === "over") {
      await session.backend.stepOver(threadId, signal);
    } else if (kind === "in") {
      await session.backend.stepIn(threadId, signal);
    } else {
      await session.backend.stepOut(threadId, signal);
    }

    await this.#waitForStopOrTermination(session, opts.waitTimeoutMs ?? 8_000, signal);
    return this.buildSnapshot(session.id, { maxDepth: 1 }, signal);
  }

  async threads(sessionId?: string, signal?: AbortSignal): Promise<{ sessionId: string; activeThreadId?: number; threads: DebugThread[] }> {
    const session = this.#requireLiveSession(sessionId);
    const threads = await session.backend.threads(signal);
    return { sessionId: session.id, activeThreadId: session.activeThreadId, threads };
  }

  async stackTrace(
    opts: { sessionId?: string; threadId?: number; levels?: number },
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; threadId: number; frames: DebugStackFrame[]; location?: StopSnapshot["location"] }> {
    const session = this.#requireStoppedSession(opts.sessionId);
    const threadId = opts.threadId ?? session.activeThreadId ?? 1;
    const frames = await session.backend.stackTrace(threadId, opts.levels ?? 20, signal);
    const top = frames[0];
    if (top && session.activeFrameId === undefined) {
      session.activeFrameId = top.id;
    }
    const location = top?.source?.path
      ? {
          file: top.source.path,
          line: top.line,
          column: top.column,
          functionName: top.name,
          snippet: readSourceSnippet(top.source.path, top.line, 4),
        }
      : undefined;
    return { sessionId: session.id, threadId, frames, location };
  }

  async variables(
    opts: {
      sessionId?: string;
      frameId?: number;
      variablesReference?: number;
      scopeFilter?: string;
      maxDepth?: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    sessionId: string;
    frameId?: number;
    scopes: Array<{ scope: DebugScope; variables: DebugVariable[] }>;
  }> {
    const session = this.#requireStoppedSession(opts.sessionId);
    const maxDepth = Math.min(Math.max(opts.maxDepth ?? 1, 0), 4);

    if (opts.variablesReference !== undefined && opts.variablesReference > 0) {
      const vars = await this.#expandVariables(session, opts.variablesReference, maxDepth, signal);
      return {
        sessionId: session.id,
        scopes: [
          {
            scope: { name: `ref#${opts.variablesReference}`, variablesReference: opts.variablesReference },
            variables: vars,
          },
        ],
      };
    }

    let frameId = opts.frameId ?? session.activeFrameId;
    if (frameId === undefined) {
      const frames = await session.backend.stackTrace(session.activeThreadId ?? 1, 5, signal);
      frameId = frames[0]?.id;
      session.activeFrameId = frameId;
    }
    if (frameId === undefined) {
      return { sessionId: session.id, scopes: [] };
    }

    const rawScopes = await session.backend.scopes(frameId, signal);
    const filterLower = opts.scopeFilter?.toLowerCase();
    const out: Array<{ scope: DebugScope; variables: DebugVariable[] }> = [];

    for (const sc of rawScopes) {
      if (filterLower && !sc.name.toLowerCase().includes(filterLower)) {
        continue;
      }
      if (!filterLower && (sc.expensive || isRegisterScope(sc))) {
        continue;
      }
      const vars = await this.#expandVariables(session, sc.variablesReference, maxDepth, signal);
      out.push({ scope: sc, variables: vars });
    }

    return { sessionId: session.id, frameId, scopes: out };
  }

  async evaluate(
    opts: {
      sessionId?: string;
      expression: string;
      frameId?: number;
      context?: string;
      maxDepth?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; evaluation: DebugEvaluateResult }> {
    const session = this.#requireLiveSession(opts.sessionId);
    let frameId = opts.frameId ?? session.activeFrameId;
    if (frameId === undefined && session.state === "stopped") {
      const frames = await this.#safeStackTrace(session, session.activeThreadId ?? 1, 3, signal);
      frameId = frames[0]?.id;
      session.activeFrameId = frameId;
    }

    const evaluation = await session.backend.evaluate(opts.expression, frameId, opts.context ?? "repl", signal);
    const maxDepth = Math.min(Math.max(opts.maxDepth ?? 1, 0), 3);
    if (evaluation.variablesReference > 0 && maxDepth > 0) {
      evaluation.children = await this.#expandVariables(session, evaluation.variablesReference, maxDepth - 1, signal);
    }
    return { sessionId: session.id, evaluation };
  }

  async disassemble(
    opts: { sessionId?: string; memoryReference: string; instructionCount?: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; instructions: DebugDisassembledInstruction[] }> {
    const session = this.#requireStoppedSession(opts.sessionId);
    if (!session.backend.disassemble) {
      throw new Error(`Adapter '${session.adapter.name}' does not support disassemble.`);
    }
    const instructions = await session.backend.disassemble(
      opts.memoryReference,
      opts.instructionCount ?? 24,
      opts.offset ?? 0,
      signal,
    );
    return { sessionId: session.id, instructions };
  }

  async readMemory(
    opts: { sessionId?: string; memoryReference: string; count?: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; memory: DebugMemoryReadResult }> {
    const session = this.#requireStoppedSession(opts.sessionId);
    if (!session.backend.readMemory) {
      throw new Error(`Adapter '${session.adapter.name}' does not support readMemory.`);
    }
    const memory = await session.backend.readMemory(
      opts.memoryReference,
      opts.count ?? 64,
      opts.offset ?? 0,
      signal,
    );
    return { sessionId: session.id, memory };
  }

  async customRequest(
    opts: { sessionId?: string; command: string; args?: unknown },
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; body: unknown }> {
    const session = this.#requireLiveSession(opts.sessionId);
    if (!session.backend.customRequest) {
      throw new Error(`Adapter '${session.adapter.name}' does not support custom DAP requests.`);
    }
    const body = await session.backend.customRequest(opts.command, opts.args, signal);
    return { sessionId: session.id, body };
  }

  getOutput(opts: { sessionId?: string; tailLines?: number; category?: "stdout" | "stderr" | "all" }): {
    sessionId: string;
    output: string;
    state: DebugSessionState;
    exitCode?: number | null;
  } {
    const session = this.#resolveOptionalSession(opts.sessionId);
    if (!session) {
      throw new Error("No debug session exists.");
    }
    const category = opts.category ?? "all";
    const text = session.outputChunks
      .filter((c) => category === "all" || c.category === category)
      .map((c) => c.output)
      .join("");
    const lines = text.split(/\r?\n/);
    const tail = opts.tailLines ? lines.slice(-opts.tailLines).join("\n") : text;
    session.unreadOutputIndex = session.outputChunks.length;
    return {
      sessionId: session.id,
      output: tail,
      state: session.state,
      exitCode: session.exitCode,
    };
  }

  async status(
    opts: { sessionId?: string; waitForStop?: boolean; waitTimeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<{ session?: SessionSummary; allSessions: SessionSummary[]; snapshot?: StopSnapshot }> {
    const target = this.#resolveOptionalSession(opts.sessionId);
    if (!target) {
      return { allSessions: this.listSessions() };
    }

    if (opts.waitForStop && target.state === "running") {
      await this.#waitForStopOrTermination(target, opts.waitTimeoutMs ?? 5_000, signal);
    }
    const snapshot = await this.buildSnapshot(target.id, { maxDepth: 1 }, signal);
    return {
      session: this.#toSummary(target),
      allSessions: this.listSessions(),
      snapshot,
    };
  }

  async disconnect(
    opts: { sessionId?: string; terminateDebuggee?: boolean; all?: boolean },
    signal?: AbortSignal,
  ): Promise<{ closedSessions: string[] }> {
    if (opts.all) {
      const ids = [...this.#sessions.keys()];
      await this.disposeAll();
      return { closedSessions: ids };
    }

    const session = this.#resolveOptionalSession(opts.sessionId);
    if (!session) {
      return { closedSessions: [] };
    }

    const terminate = opts.terminateDebuggee ?? (session.mode === "launch");
    try {
      await session.backend.disconnect({ terminateDebuggee: terminate }, signal);
    } catch {
      // ignore disconnect race on already-exited debuggee
    }
    await session.backend.dispose();

    this.#sessions.delete(session.id);
    if (this.#activeSessionId === session.id) {
      this.#activeSessionId = [...this.#sessions.keys()].at(-1);
    }
    this.#notifyChange();
    return { closedSessions: [session.id] };
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#activeSessionId = undefined;
    await Promise.allSettled(
      sessions.map(async (s) => {
        const terminate = s.mode === "launch";
        try {
          await s.backend.disconnect({ terminateDebuggee: terminate });
        } catch {
          // ignore
        }
        await s.backend.dispose();
      }),
    );
    this.#notifyChange();
  }

  async runProbe(opts: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();
    const resolvedProgram = resolveToolPath(opts.program, opts.cwd);
    if (!fs.existsSync(resolvedProgram)) {
      throw new Error(`Program not found: ${resolvedProgram}`);
    }

    const { adapter, launchOverrides } = selectAdapterForLaunch({
      program: resolvedProgram,
      cwd: opts.cwd,
      adapter: opts.adapter,
      pythonPath: opts.pythonPath,
    });

    const { bpMap, perLineExpressions } = this.#prepareProbeBreakpoints(opts, resolvedProgram);
    const session = await this.#createManagedSession({
      id: `probe_${++this.#counter}`,
      mode: "launch",
      adapter,
      cwd: opts.cwd,
      program: resolvedProgram,
      env: opts.env,
      registerInMap: false,
    });

    const maxHits = Math.min(Math.max(opts.maxHits ?? 5, 1), 25);
    const maxDepth = Math.min(Math.max(opts.maxDepth ?? 2, 0), 4);
    const totalTimeoutMs = Math.min(Math.max(opts.timeoutMs ?? 20_000, 1_000), 120_000);
    const deadline = started + totalTimeoutMs;
    const hits: ProbeHitSnapshot[] = [];
    let timedOut = false;

    try {
      const filters = exceptionFiltersForPolicy(opts.breakOnExceptions ?? "uncaught", adapter.name);
      await session.backend.startLaunch(
        {
          program: resolvedProgram,
          args: opts.args,
          cwd: opts.cwd,
          env: opts.env,
          stopOnEntry: opts.stopOnEntry,
          launchArgs: launchOverrides,
          initialBreakpoints: bpMap,
          initialFunctionBreakpoints: [],
          exceptionFilters: filters,
        },
        signal,
        Math.min(totalTimeoutMs, 15_000),
      );
      if (session.state === "starting") {
        session.state = "running";
      }

      timedOut = await this.#collectProbeHits({
        session,
        opts,
        perLineExpressions,
        hits,
        maxHits,
        maxDepth,
        deadline,
        signal,
      });
    } finally {
      try {
        await session.backend.disconnect({ terminateDebuggee: true });
      } catch {
        // ignore
      }
      await session.backend.dispose();
    }

    const stdout = session.outputChunks
      .filter((c) => c.category === "stdout" || c.category === "console")
      .map((c) => c.output)
      .join("");
    const stderr = session.outputChunks
      .filter((c) => c.category === "stderr")
      .map((c) => c.output)
      .join("");

    return {
      adapter: adapter.name,
      program: formatDisplayPath(resolvedProgram, opts.cwd),
      completed: session.state === "terminated" && !timedOut,
      timedOut,
      exitCode: session.exitCode,
      hits,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
  }

  async buildSnapshot(
    sessionId: string,
    opts?: { maxDepth?: number },
    signal?: AbortSignal,
  ): Promise<StopSnapshot> {
    const session = this.#requireSession(sessionId);
    const recentOutput = this.#consumeUnreadOutput(session);

    if (session.state !== "stopped") {
      return {
        sessionId: session.id,
        adapter: session.adapter.name,
        mode: session.mode,
        state: session.state,
        exitCode: session.exitCode,
        recentOutput,
      };
    }

    const threadId = session.activeThreadId ?? 1;
    const frames = await this.#safeStackTrace(session, threadId, 15, signal);
    const top = frames[0];
    if (top) {
      session.activeFrameId = top.id;
    }

    await this.#populateExceptionIfNeeded(session, threadId, signal);
    const { scopes, locals } = await this.#collectFrameLocals(session, top?.id, opts?.maxDepth ?? 1, signal);

    const location = top?.source?.path
      ? {
          file: top.source.path,
          line: top.line,
          column: top.column,
          functionName: top.name,
          snippet: readSourceSnippet(top.source.path, top.line, 4),
        }
      : undefined;

    return {
      sessionId: session.id,
      adapter: session.adapter.name,
      mode: session.mode,
      state: session.state,
      stopped: session.stopped,
      location,
      stack: frames,
      scopes,
      locals,
      recentOutput,
    };
  }

  #resolveOptionalSession(sessionId?: string): ManagedSession | undefined {
    if (sessionId) {
      return this.#requireSession(sessionId);
    }
    if (!this.#activeSessionId) {
      return undefined;
    }
    return this.#sessions.get(this.#activeSessionId);
  }

  #groupBreakpointInputs(
    opts: {
      cwd: string;
      file?: string;
      lines?: number[];
      breakpoints?: InlineBreakpointInput[];
      functionBreakpoints?: Array<{ name: string; condition?: string }>;
    },
    defaultFile: string | undefined,
  ): Map<string, SourceBreakpointSpec[]> {
    const grouped = new Map<string, SourceBreakpointSpec[]>();
    if (opts.lines) {
      if (!defaultFile) {
        throw new Error("set_breakpoints with 'lines' requires 'file' when no active session program exists.");
      }
      grouped.set(defaultFile, opts.lines.map((line) => ({ line })));
    }
    for (const bp of opts.breakpoints ?? []) {
      const target = bp.file ? resolveToolPath(bp.file, opts.cwd) : defaultFile;
      if (!target) {
        throw new Error("Each breakpoint requires 'file' when no default 'file' or active session program is set.");
      }
      const list = grouped.get(target) ?? [];
      list.push({
        line: bp.line,
        column: bp.column,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
        logMessage: bp.logMessage,
      });
      grouped.set(target, list);
    }
    if (opts.file && grouped.size === 0 && !opts.functionBreakpoints) {
      grouped.set(resolveToolPath(opts.file, opts.cwd), []);
    }
    return grouped;
  }

  #stageBreakpoints(
    grouped: Map<string, SourceBreakpointSpec[]>,
    functionBreakpoints?: Array<{ name: string; condition?: string }>,
  ): {
    staged: boolean;
    verifiedBreakpoints: VerifiedBreakpoint[];
    verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[];
  } {
    const stagedOut: VerifiedBreakpoint[] = [];
    for (const [filePath, specs] of grouped.entries()) {
      if (specs.length === 0) {
        this.#stagedBreakpoints.delete(filePath);
      } else {
        this.#stagedBreakpoints.set(filePath, specs);
        for (const s of specs) {
          stagedOut.push({
            verified: false,
            file: filePath,
            line: s.line,
            requestedLine: s.line,
            column: s.column,
            condition: s.condition,
            logMessage: s.logMessage,
            message: "Staged for next launch/attach",
          });
        }
      }
    }
    const stagedFns: VerifiedFunctionBreakpoint[] = [];
    if (functionBreakpoints) {
      this.#stagedFunctionBreakpoints.length = 0;
      this.#stagedFunctionBreakpoints.push(...functionBreakpoints);
      for (const f of functionBreakpoints) {
        stagedFns.push({ name: f.name, verified: false, message: "Staged for next launch/attach" });
      }
    }
    return {
      staged: true,
      verifiedBreakpoints: stagedOut,
      verifiedFunctionBreakpoints: stagedFns,
    };
  }

  #prepareProbeBreakpoints(opts: ProbeOptions, resolvedProgram: string): {
    bpMap: Map<string, SourceBreakpointSpec[]>;
    perLineExpressions: Map<string, string[]>;
  } {
    const bpMap = new Map<string, SourceBreakpointSpec[]>();
    const perLineExpressions = new Map<string, string[]>();
    for (const bp of opts.breakpoints ?? []) {
      const file = bp.file ? resolveToolPath(bp.file, opts.cwd) : resolvedProgram;
      const list = bpMap.get(file) ?? [];
      list.push({
        line: bp.line,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
      });
      bpMap.set(file, list);
      if (bp.expressions && bp.expressions.length > 0) {
        perLineExpressions.set(`${file}:${bp.line}`, bp.expressions);
      }
    }
    return { bpMap, perLineExpressions };
  }

  async #collectProbeHits(params: {
    session: ManagedSession;
    opts: ProbeOptions;
    perLineExpressions: Map<string, string[]>;
    hits: ProbeHitSnapshot[];
    maxHits: number;
    maxDepth: number;
    deadline: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const { session, opts, perLineExpressions, hits, maxHits, maxDepth, deadline, signal } = params;
    while (hits.length < maxHits) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return true;
      }

      await this.#waitForStopOrTermination(session, remainingMs, signal);
      if (session.state === "terminated") {
        return false;
      }
      if (session.state !== "stopped") {
        return true;
      }

      const hit = await this.#captureSingleProbeHit(session, opts, perLineExpressions, hits.length + 1, maxDepth, signal);
      hits.push(hit);

      if (hit.reason === "exception" || hits.length >= maxHits) {
        break;
      }

      const threadId = session.activeThreadId ?? 1;
      session.state = "running";
      session.stopped = undefined;
      session.activeFrameId = undefined;
      await session.backend.continueExecution(threadId, signal);
    }

    if (session.state === "running") {
      await this.#waitForStopOrTermination(session, Math.min(400, Math.max(50, deadline - Date.now())), signal);
    }
    return false;
  }

  async #captureSingleProbeHit(
    session: ManagedSession,
    opts: ProbeOptions,
    perLineExpressions: Map<string, string[]>,
    hitIndex: number,
    maxDepth: number,
    signal?: AbortSignal,
  ): Promise<ProbeHitSnapshot> {
    const threadId = session.activeThreadId ?? 1;
    const frames = await this.#safeStackTrace(session, threadId, 12, signal);
    const top = frames[0];
    session.activeFrameId = top?.id;

    const file = top?.source?.path;
    const line = top?.line;
    const snippet = file && line ? readSourceSnippet(file, line, 3) : undefined;
    await this.#populateExceptionIfNeeded(session, threadId, signal);
    const { locals } = await this.#collectFrameLocals(session, top?.id, maxDepth, signal);

    const exprSet = new Set<string>(opts.expressions ?? []);
    if (file && line) {
      for (const e of perLineExpressions.get(`${file}:${line}`) ?? []) {
        exprSet.add(e);
      }
    }

    const evaluations: DebugEvaluateResult[] = [];
    for (const expr of exprSet) {
      const ev = await session.backend.evaluate(expr, top?.id, "watch", signal);
      if (ev.variablesReference > 0 && maxDepth > 0) {
        ev.children = await this.#expandVariables(session, ev.variablesReference, maxDepth - 1, signal);
      }
      evaluations.push(ev);
    }

    return {
      hitIndex,
      reason: session.stopped?.reason ?? "breakpoint",
      description: session.stopped?.description,
      file: file ? formatDisplayPath(file, opts.cwd) : undefined,
      line,
      functionName: top?.name,
      snippet,
      stack: frames,
      locals,
      evaluations,
      exception: session.stopped?.exception,
    };
  }

  async #safeStackTrace(
    session: ManagedSession,
    threadId: number,
    levels: number,
    signal?: AbortSignal,
  ): Promise<DebugStackFrame[]> {
    try {
      return await session.backend.stackTrace(threadId, levels, signal);
    } catch {
      return [];
    }
  }

  async #populateExceptionIfNeeded(
    session: ManagedSession,
    threadId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!session.stopped || session.stopped.exception || session.stopped.reason !== "exception") {
      return;
    }
    try {
      const info: DebugExceptionInfo | undefined = await session.backend.exceptionInfo(threadId, signal);
      if (info && session.stopped) {
        session.stopped.exception = info;
      }
    } catch {
      // ignore unsupported exceptionInfo
    }
  }

  async #collectFrameLocals(
    session: ManagedSession,
    frameId: number | undefined,
    maxDepth: number,
    signal?: AbortSignal,
  ): Promise<{ scopes: DebugScope[]; locals: DebugVariable[] }> {
    if (frameId === undefined) {
      return { scopes: [], locals: [] };
    }
    let scopes: DebugScope[] = [];
    try {
      scopes = await session.backend.scopes(frameId, signal);
    } catch {
      return { scopes: [], locals: [] };
    }
    const locals: DebugVariable[] = [];
    for (const sc of scopes) {
      if (isNoisySnapshotScope(sc)) {
        continue;
      }
      const vars = await this.#expandVariables(session, sc.variablesReference, maxDepth, signal);
      locals.push(...vars.slice(0, 30));
      if (locals.length >= 40) {
        break;
      }
    }
    return { scopes, locals: locals.slice(0, 40) };
  }

  async #createManagedSession(opts: {
    id: string;
    name?: string;
    mode: DebugLaunchMode;
    adapter: ResolvedAdapter;
    cwd: string;
    program?: string;
    pid?: number;
    host?: string;
    port?: number;
    env?: Record<string, string>;
    registerInMap?: boolean;
  }): Promise<ManagedSession> {
    let sessionRef: ManagedSession | undefined;

    const callbacks: DebugBackendCallbacks = {
      onStopped: (stopped: DebugStoppedEvent) => {
        if (!sessionRef) {
          return;
        }
        sessionRef.state = "stopped";
        sessionRef.stopped = stopped;
        if (stopped.threadId !== undefined) {
          sessionRef.activeThreadId = stopped.threadId;
        }
        sessionRef.activeFrameId = undefined;
        this.#wakeWaiters(sessionRef);
        this.#notifyChange();
      },
      onContinued: () => {
        if (!sessionRef || sessionRef.state === "terminated") {
          return;
        }
        sessionRef.state = "running";
        sessionRef.stopped = undefined;
        sessionRef.activeFrameId = undefined;
        this.#notifyChange();
      },
      onOutput: (chunk: DebugOutputEvent) => {
        if (!sessionRef || !chunk.output) {
          return;
        }
        sessionRef.outputChunks.push(chunk);
        sessionRef.outputCharCount += chunk.output.length;
        while (
          sessionRef.outputChunks.length > MAX_OUTPUT_CHUNKS
          || (sessionRef.outputCharCount > MAX_OUTPUT_CHARS && sessionRef.outputChunks.length > 1)
        ) {
          const dropped = sessionRef.outputChunks.shift();
          if (dropped) {
            sessionRef.outputCharCount -= dropped.output.length;
            sessionRef.unreadOutputIndex = Math.max(0, sessionRef.unreadOutputIndex - 1);
          }
        }
      },
      onExited: (exitCode?: number) => {
        if (sessionRef) {
          sessionRef.exitCode = exitCode ?? 0;
        }
      },
      onTerminated: () => {
        if (!sessionRef) {
          return;
        }
        sessionRef.state = "terminated";
        this.#wakeWaiters(sessionRef);
        this.#notifyChange();
      },
    };

    const backend: DebugBackend = opts.adapter.transport === "node-inspector"
      ? new NodeInspectorBackend(opts.adapter, callbacks)
      : await DapBackend.create(opts.adapter, opts.cwd, callbacks, opts.env);

    const session: ManagedSession = {
      id: opts.id,
      name: opts.name,
      mode: opts.mode,
      adapter: opts.adapter,
      backend,
      cwd: opts.cwd,
      program: opts.program,
      pid: opts.pid,
      host: opts.host,
      port: opts.port,
      state: "starting",
      breakpointsByFile: new Map(),
      functionBreakpoints: [],
      outputChunks: [],
      outputCharCount: 0,
      unreadOutputIndex: 0,
      startedAt: Date.now(),
      stateWaiters: new Set(),
    };
    sessionRef = session;

    if (opts.registerInMap !== false) {
      this.#sessions.set(session.id, session);
    }
    return session;
  }

  #collectInitialBreakpoints(
    cwd: string,
    defaultProgram: string | undefined,
    inline?: InlineBreakpointInput[],
  ): Map<string, SourceBreakpointSpec[]> {
    const out = new Map<string, SourceBreakpointSpec[]>();
    for (const [file, specs] of this.#stagedBreakpoints.entries()) {
      out.set(file, [...specs]);
    }
    this.#stagedBreakpoints.clear();

    for (const bp of inline ?? []) {
      const target = bp.file ? resolveToolPath(bp.file, cwd) : defaultProgram;
      if (!target) {
        throw new Error(`Inline breakpoint on line ${bp.line} requires 'file' when 'program' is not specified.`);
      }
      const list = out.get(target) ?? [];
      list.push({
        line: bp.line,
        column: bp.column,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
        logMessage: bp.logMessage,
      });
      out.set(target, list);
    }
    return out;
  }

  #storeVerifiedBreakpoints(session: ManagedSession, verified: VerifiedBreakpoint[]): void {
    session.breakpointsByFile.clear();
    for (const bp of verified) {
      if (!bp.file) {
        continue;
      }
      const list = session.breakpointsByFile.get(bp.file) ?? [];
      list.push(bp);
      session.breakpointsByFile.set(bp.file, list);
    }
  }

  async #expandVariables(
    session: ManagedSession,
    variablesReference: number,
    depthRemaining: number,
    signal?: AbortSignal,
  ): Promise<DebugVariable[]> {
    let vars: DebugVariable[] = [];
    try {
      vars = await session.backend.variables(variablesReference, signal);
    } catch {
      return [];
    }
    if (depthRemaining <= 0) {
      return vars;
    }
    const capped = vars.slice(0, 35);
    for (const item of capped) {
      if (item.variablesReference > 0) {
        item.children = await this.#expandVariables(session, item.variablesReference, depthRemaining - 1, signal);
      }
    }
    return vars;
  }

  #consumeUnreadOutput(session: ManagedSession): string {
    if (session.unreadOutputIndex >= session.outputChunks.length) {
      return "";
    }
    const slice = session.outputChunks.slice(session.unreadOutputIndex);
    session.unreadOutputIndex = session.outputChunks.length;
    const joined = slice.map((c) => c.output).join("");
    return joined.length > 4_000 ? `...(truncated)\n${joined.slice(-4_000)}` : joined;
  }

  async #waitForStopOrTermination(
    session: ManagedSession,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (session.state === "stopped" || session.state === "terminated") {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      const onWake = () => {
        if (session.state === "stopped" || session.state === "terminated") {
          cleanup();
          resolve();
        }
      };

      const onAbort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Wait aborted"));
      };

      const cleanup = () => {
        clearTimeout(timer);
        session.stateWaiters.delete(onWake);
        signal?.removeEventListener("abort", onAbort);
      };

      session.stateWaiters.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #wakeWaiters(session: ManagedSession): void {
    for (const w of session.stateWaiters) {
      w();
    }
  }

  #getActiveLiveSession(): ManagedSession | undefined {
    if (!this.#activeSessionId) {
      return undefined;
    }
    const s = this.#sessions.get(this.#activeSessionId);
    if (!s || s.state === "terminated") {
      return undefined;
    }
    return s;
  }

  #requireSession(sessionId: string): ManagedSession {
    const s = this.#sessions.get(sessionId);
    if (!s) {
      const available = [...this.#sessions.keys()].join(", ") || "none";
      throw new Error(`Debug session '${sessionId}' not found. Active sessions: ${available}`);
    }
    return s;
  }

  #requireLiveSession(sessionId?: string): ManagedSession {
    const id = sessionId ?? this.#activeSessionId;
    if (!id) {
      throw new Error("No active debug session. Start one with action='launch' or action='attach'.");
    }
    const s = this.#requireSession(id);
    if (s.state === "terminated") {
      throw new Error(`Debug session '${s.id}' has already terminated (exitCode=${String(s.exitCode ?? "unknown")}).`);
    }
    return s;
  }

  #requireStoppedSession(sessionId?: string): ManagedSession {
    const s = this.#requireLiveSession(sessionId);
    if (s.state !== "stopped") {
      throw new Error(
        `Debug session '${s.id}' is currently '${s.state}', not paused. Call action='pause' or wait for a breakpoint first.`,
      );
    }
    return s;
  }

  #toSummary(s: ManagedSession): SessionSummary {
    let bpCount = s.functionBreakpoints.length;
    for (const list of s.breakpointsByFile.values()) {
      bpCount += list.length;
    }
    return {
      id: s.id,
      name: s.name,
      active: s.id === this.#activeSessionId,
      mode: s.mode,
      adapter: s.adapter.name,
      transport: s.adapter.transport,
      state: s.state,
      program: s.program ? formatDisplayPath(s.program, s.cwd) : undefined,
      pid: s.pid,
      host: s.host,
      port: s.port,
      cwd: s.cwd,
      stoppedReason: s.stopped?.reason,
      activeThreadId: s.activeThreadId,
      breakpointCount: bpCount,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
    };
  }
}
