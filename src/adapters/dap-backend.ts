/**
 * Standard DAP DebugBackend over DapProtocolClient (supports stdio, tcp-spawn, and tcp-connect).
 * Handles both post-launch and pre-launch 'initialized' event orderings cleanly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  DapCapabilities,
  DebugBackend,
  DebugBackendCallbacks,
  DebugDisassembledInstruction,
  DebugEvaluateResult,
  DebugExceptionInfo,
  DebugMemoryReadResult,
  DebugScope,
  DebugStackFrame,
  DebugThread,
  DebugVariable,
  ResolvedAdapter,
  SourceBreakpointSpec,
  VerifiedBreakpoint,
  VerifiedFunctionBreakpoint,
} from "../types.ts";
import { DapProtocolClient } from "../dap/protocol-client.ts";
import { StdioDapTransport, TcpDapTransport } from "../dap/transport.ts";
import { NON_INTERACTIVE_ENV, terminateProcessTree } from "../utils/process-tree.ts";

export class DapBackend implements DebugBackend {
  readonly adapter: ResolvedAdapter;
  readonly #client: DapProtocolClient;
  readonly #spawnedTerminals: ChildProcess[] = [];

  private constructor(adapter: ResolvedAdapter, client: DapProtocolClient) {
    this.adapter = adapter;
    this.#client = client;
  }

  static async create(
    adapter: ResolvedAdapter,
    cwd: string,
    callbacks: DebugBackendCallbacks,
    env?: Record<string, string>,
    timeoutMs = 15_000,
  ): Promise<DapBackend> {
    const client = await DapProtocolClient.create(async (events) => {
      if (adapter.transport === "tcp-connect") {
        if (!adapter.host || !adapter.port) {
          throw new Error(`Adapter '${adapter.name}' requires host and port for tcp-connect`);
        }
        return TcpDapTransport.connect({
          host: adapter.host,
          port: adapter.port,
          timeoutMs,
          events,
        });
      }
      if (adapter.transport === "tcp-spawn") {
        const cmd = adapter.resolvedBinary ?? adapter.command;
        if (!cmd) {
          throw new Error(`Adapter '${adapter.name}' is missing command`);
        }
        return TcpDapTransport.spawnAndConnect({
          command: cmd,
          args: adapter.args ?? [],
          cwd,
          env,
          timeoutMs,
          events,
        });
      }
      const cmd = adapter.resolvedBinary ?? adapter.command;
      if (!cmd) {
        throw new Error(`Adapter '${adapter.name}' is missing command`);
      }
      return StdioDapTransport.spawn({
        command: cmd,
        args: adapter.args ?? [],
        cwd,
        env,
        events,
      });
    });

    const backend = new DapBackend(adapter, client);
    backend.#wireEvents(callbacks);
    return backend;
  }

  get capabilities(): DapCapabilities {
    return this.#client.capabilities;
  }

  isAlive(): boolean {
    return this.#client.isAlive();
  }

  async startLaunch(
    opts: {
      program: string;
      args?: string[];
      cwd: string;
      env?: Record<string, string>;
      stopOnEntry?: boolean;
      launchArgs?: Record<string, unknown>;
      initialBreakpoints: Map<string, SourceBreakpointSpec[]>;
      initialFunctionBreakpoints: Array<{ name: string; condition?: string }>;
      exceptionFilters?: string[];
    },
    signal?: AbortSignal,
    timeoutMs = 25_000,
  ): Promise<{ verifiedBreakpoints: VerifiedBreakpoint[]; verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[] }> {
    let initializedSeen = false;
    let resolveInitialized!: () => void;
    const initializedPromise = new Promise<void>((resolve) => {
      resolveInitialized = resolve;
    });
    const unsubInit = this.#client.onEvent("initialized", () => {
      initializedSeen = true;
      resolveInitialized();
    });

    try {
      await this.#client.initialize(this.adapter.name, signal, timeoutMs);

      const launchPayload: Record<string, unknown> = {
        request: "launch",
        ...(this.adapter.launchDefaults ?? {}),
        ...(this.adapter.debuggeePython ? { python: this.adapter.debuggeePython } : {}),
        program: opts.program,
        cwd: opts.cwd,
        ...(opts.args ? { args: opts.args } : {}),
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
        ...(opts.stopOnEntry === undefined ? {} : { stopOnEntry: opts.stopOnEntry }),
        ...(opts.launchArgs ?? {}),
      };

      return await this.#runBootSequence(
        () => this.#client.sendRequest("launch", launchPayload, signal, timeoutMs),
        () => initializedSeen,
        initializedPromise,
        opts.initialBreakpoints,
        opts.initialFunctionBreakpoints,
        opts.exceptionFilters,
        signal,
        timeoutMs,
      );
    } finally {
      unsubInit();
    }
  }

  async startAttach(
    opts: {
      cwd: string;
      pid?: number;
      host?: string;
      port?: number;
      program?: string;
      attachArgs?: Record<string, unknown>;
      initialBreakpoints: Map<string, SourceBreakpointSpec[]>;
      initialFunctionBreakpoints: Array<{ name: string; condition?: string }>;
      exceptionFilters?: string[];
    },
    signal?: AbortSignal,
    timeoutMs = 25_000,
  ): Promise<{ verifiedBreakpoints: VerifiedBreakpoint[]; verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[] }> {
    let initializedSeen = false;
    let resolveInitialized!: () => void;
    const initializedPromise = new Promise<void>((resolve) => {
      resolveInitialized = resolve;
    });
    const unsubInit = this.#client.onEvent("initialized", () => {
      initializedSeen = true;
      resolveInitialized();
    });

    try {
      await this.#client.initialize(this.adapter.name, signal, timeoutMs);

      const attachPayload: Record<string, unknown> = {
        request: "attach",
        ...(this.adapter.attachDefaults ?? {}),
        cwd: opts.cwd,
        ...(opts.program ? { program: opts.program } : {}),
        ...(opts.pid === undefined ? {} : { pid: opts.pid, processId: opts.pid }),
        // For direct tcp-connect (e.g. debugpy.listen), do NOT send connect/port inside attach
        // because the socket IS already connected to the debugpy server.
        ...(this.adapter.transport === "tcp-connect" || opts.port === undefined ? {} : { port: opts.port }),
        ...(this.adapter.transport === "tcp-connect" || !opts.host ? {} : { host: opts.host }),
        ...(opts.attachArgs ?? {}),
      };

      return await this.#runBootSequence(
        () => this.#client.sendRequest("attach", attachPayload, signal, timeoutMs),
        () => initializedSeen,
        initializedPromise,
        opts.initialBreakpoints,
        opts.initialFunctionBreakpoints,
        opts.exceptionFilters,
        signal,
        timeoutMs,
      );
    } finally {
      unsubInit();
    }
  }

  async #runBootSequence(
    sendStartRequest: () => Promise<unknown>,
    isInitialized: () => boolean,
    initializedPromise: Promise<void>,
    initialBreakpoints: Map<string, SourceBreakpointSpec[]>,
    initialFunctionBreakpoints: Array<{ name: string; condition?: string }>,
    exceptionFilters: string[] | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ verifiedBreakpoints: VerifiedBreakpoint[]; verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[] }> {
    let startError: unknown;
    let rejectStartEarly!: (err: unknown) => void;
    const startFailureRace = new Promise<never>((_, reject) => {
      rejectStartEarly = reject;
    });

    const startPromise = sendStartRequest().catch((err) => {
      startError = err;
      rejectStartEarly(err);
      throw err;
    });

    if (!isInitialized()) {
      const initTimeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for DAP 'initialized' event from '${this.adapter.name}'`));
        }, timeoutMs);
        initializedPromise.finally(() => clearTimeout(timer));
        startFailureRace.catch(() => clearTimeout(timer));
      });
      await Promise.race([initializedPromise, startFailureRace, initTimeout]);
    }

    if (startError) {
      throw startError instanceof Error ? startError : new Error(String(startError));
    }

    const verifiedBreakpoints: VerifiedBreakpoint[] = [];
    for (const [file, specs] of initialBreakpoints.entries()) {
      if (specs.length > 0) {
        const res = await this.setSourceBreakpoints(file, specs, signal, timeoutMs);
        verifiedBreakpoints.push(...res);
      }
    }

    let verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[] = [];
    if (initialFunctionBreakpoints.length > 0 && this.capabilities.supportsFunctionBreakpoints) {
      verifiedFunctionBreakpoints = await this.setFunctionBreakpoints(initialFunctionBreakpoints, signal, timeoutMs);
    }

    if (exceptionFilters !== undefined) {
      await this.setExceptionBreakpoints(exceptionFilters, signal, timeoutMs);
    }

    if (this.capabilities.supportsConfigurationDoneRequest !== false) {
      await Promise.race([
        this.#client.sendRequest("configurationDone", {}, signal, timeoutMs),
        startFailureRace,
      ]);
    }

    await startPromise;
    return { verifiedBreakpoints, verifiedFunctionBreakpoints };
  }

  async setSourceBreakpoints(
    file: string,
    specs: SourceBreakpointSpec[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<VerifiedBreakpoint[]> {
    const resp = await this.#client.sendRequest<{
      breakpoints?: Array<{
        id?: number;
        verified?: boolean;
        line?: number;
        column?: number;
        message?: string;
        source?: { path?: string };
      }>;
    }>(
      "setBreakpoints",
      {
        source: { path: file },
        breakpoints: specs.map((bp) => ({
          line: bp.line,
          ...(bp.column === undefined ? {} : { column: bp.column }),
          ...(bp.condition ? { condition: bp.condition } : {}),
          ...(bp.hitCondition ? { hitCondition: bp.hitCondition } : {}),
          ...(bp.logMessage ? { logMessage: bp.logMessage } : {}),
        })),
        sourceModified: false,
      },
      signal,
      timeoutMs,
    );

    const returned = resp?.breakpoints ?? [];
    return specs.map((spec, idx) => {
      const actual = returned[idx];
      return {
        id: actual?.id,
        verified: actual?.verified ?? false,
        file: actual?.source?.path ?? file,
        line: actual?.line ?? spec.line,
        requestedLine: spec.line,
        column: actual?.column ?? spec.column,
        condition: spec.condition,
        hitCondition: spec.hitCondition,
        logMessage: spec.logMessage,
        message: actual?.message,
      };
    });
  }

  async setFunctionBreakpoints(
    specs: Array<{ name: string; condition?: string }>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<VerifiedFunctionBreakpoint[]> {
    const resp = await this.#client.sendRequest<{
      breakpoints?: Array<{ id?: number; verified?: boolean; line?: number; message?: string }>;
    }>(
      "setFunctionBreakpoints",
      {
        breakpoints: specs.map((fn) => ({
          name: fn.name,
          ...(fn.condition ? { condition: fn.condition } : {}),
        })),
      },
      signal,
      timeoutMs,
    );

    const returned = resp?.breakpoints ?? [];
    return specs.map((spec, idx) => {
      const actual = returned[idx];
      return {
        id: actual?.id,
        name: spec.name,
        verified: actual?.verified ?? false,
        line: actual?.line,
        condition: spec.condition,
        message: actual?.message,
      };
    });
  }

  async setExceptionBreakpoints(filters: string[], signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    const availableFilters = this.capabilities.exceptionBreakpointFilters;
    const validFilters = availableFilters && availableFilters.length > 0
      ? filters.filter((f) => availableFilters.some((af) => af.filter === f))
      : filters;
    await this.#client.sendRequest("setExceptionBreakpoints", { filters: validFilters }, signal, timeoutMs);
  }

  async continueExecution(threadId = 1, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#client.sendRequest("continue", { threadId }, signal, timeoutMs);
  }

  async pauseExecution(threadId = 1, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#client.sendRequest("pause", { threadId }, signal, timeoutMs);
  }

  async stepOver(threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#client.sendRequest("next", { threadId }, signal, timeoutMs);
  }

  async stepIn(threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#client.sendRequest("stepIn", { threadId }, signal, timeoutMs);
  }

  async stepOut(threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#client.sendRequest("stepOut", { threadId }, signal, timeoutMs);
  }

  async threads(signal?: AbortSignal, timeoutMs?: number): Promise<DebugThread[]> {
    const resp = await this.#client.sendRequest<{ threads?: DebugThread[] }>("threads", {}, signal, timeoutMs);
    return resp?.threads ?? [];
  }

  async stackTrace(threadId: number, levels = 20, signal?: AbortSignal, timeoutMs?: number): Promise<DebugStackFrame[]> {
    const resp = await this.#client.sendRequest<{ stackFrames?: DebugStackFrame[] }>(
      "stackTrace",
      { threadId, startFrame: 0, levels },
      signal,
      timeoutMs,
    );
    return resp?.stackFrames ?? [];
  }

  async scopes(frameId: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugScope[]> {
    const resp = await this.#client.sendRequest<{ scopes?: DebugScope[] }>("scopes", { frameId }, signal, timeoutMs);
    return resp?.scopes ?? [];
  }

  async variables(variablesReference: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugVariable[]> {
    const resp = await this.#client.sendRequest<{ variables?: DebugVariable[] }>(
      "variables",
      { variablesReference },
      signal,
      timeoutMs,
    );
    return resp?.variables ?? [];
  }

  async evaluate(
    expression: string,
    frameId?: number,
    context = "repl",
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<DebugEvaluateResult> {
    try {
      const resp = await this.#client.sendRequest<{
        result?: string;
        type?: string;
        variablesReference?: number;
      }>(
        "evaluate",
        {
          expression,
          ...(frameId === undefined ? {} : { frameId }),
          context,
        },
        signal,
        timeoutMs,
      );
      return {
        expression,
        result: resp?.result ?? "",
        type: resp?.type,
        variablesReference: resp?.variablesReference ?? 0,
      };
    } catch (err) {
      return {
        expression,
        result: "",
        variablesReference: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async exceptionInfo(threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugExceptionInfo | undefined> {
    if (!this.capabilities.supportsExceptionInfoRequest) {
      return undefined;
    }
    try {
      return await this.#client.sendRequest<DebugExceptionInfo>("exceptionInfo", { threadId }, signal, timeoutMs);
    } catch {
      return undefined;
    }
  }

  async disassemble(
    memoryReference: string,
    instructionCount: number,
    offset = 0,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<DebugDisassembledInstruction[]> {
    if (!this.capabilities.supportsDisassembleRequest) {
      throw new Error(`Adapter '${this.adapter.name}' does not support disassembly`);
    }
    const resp = await this.#client.sendRequest<{ instructions?: DebugDisassembledInstruction[] }>(
      "disassemble",
      { memoryReference, instructionCount, instructionOffset: offset, resolveSymbols: true },
      signal,
      timeoutMs,
    );
    return resp?.instructions ?? [];
  }

  async readMemory(
    memoryReference: string,
    count: number,
    offset = 0,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<DebugMemoryReadResult> {
    if (!this.capabilities.supportsReadMemoryRequest) {
      throw new Error(`Adapter '${this.adapter.name}' does not support readMemory`);
    }
    const resp = await this.#client.sendRequest<{
      address?: string;
      data?: string;
      unreadableBytes?: number;
    }>("readMemory", { memoryReference, count, offset }, signal, timeoutMs);
    const dataBase64 = resp?.data ?? "";
    const bytesRead = Buffer.from(dataBase64, "base64").length;
    return {
      address: resp?.address ?? memoryReference,
      dataBase64,
      bytesRead,
      unreadableBytes: resp?.unreadableBytes,
    };
  }

  async customRequest(command: string, args?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    return this.#client.sendRequest(command, args, signal, timeoutMs);
  }

  async disconnect(opts: { terminateDebuggee: boolean }, signal?: AbortSignal, timeoutMs = 4_000): Promise<void> {
    if (this.#client.isAlive()) {
      try {
        await this.#client.sendRequest(
          "disconnect",
          {
            restart: false,
            ...(this.capabilities.supportTerminateDebuggee ? { terminateDebuggee: opts.terminateDebuggee } : {}),
          },
          signal,
          timeoutMs,
        );
      } catch {
        // best effort before disposal
      }
    }
    await this.dispose();
  }

  async dispose(): Promise<void> {
    for (const term of this.#spawnedTerminals) {
      await terminateProcessTree(term, { detachedGroup: process.platform !== "win32" });
    }
    this.#spawnedTerminals.length = 0;
    await this.#client.dispose();
  }

  #wireEvents(callbacks: DebugBackendCallbacks): void {
    this.#client.onEvent("stopped", (raw) => {
      const body = (raw ?? {}) as {
        reason?: string;
        description?: string;
        text?: string;
        threadId?: number;
        allThreadsStopped?: boolean;
        hitBreakpointIds?: number[];
      };
      callbacks.onStopped({
        reason: body.reason ?? "stopped",
        description: body.description,
        text: body.text,
        threadId: body.threadId,
        allThreadsStopped: body.allThreadsStopped,
        hitBreakpointIds: body.hitBreakpointIds,
      });
    });

    this.#client.onEvent("continued", (raw) => {
      const body = (raw ?? {}) as { threadId?: number };
      callbacks.onContinued(body.threadId);
    });

    this.#client.onEvent("output", (raw) => {
      const body = (raw ?? {}) as { category?: string; output?: string };
      if (typeof body.output === "string") {
        callbacks.onOutput({
          category: body.category ?? "console",
          output: body.output,
        });
      }
    });

    this.#client.onEvent("exited", (raw) => {
      const body = (raw ?? {}) as { exitCode?: number };
      callbacks.onExited(body.exitCode);
    });

    this.#client.onEvent("terminated", () => {
      callbacks.onTerminated();
    });

    // Support adapters (like codelldb / debugpy integratedTerminal) requesting runInTerminal
    this.#client.onReverseRequest("runInTerminal", (raw) => {
      const args = (raw ?? {}) as {
        cwd?: string;
        args?: string[];
        env?: Record<string, string | null>;
      };
      const cmdArgs = Array.isArray(args.args) ? args.args.filter((x): x is string => typeof x === "string") : [];
      if (cmdArgs.length === 0) {
        throw new Error("runInTerminal called without command args");
      }
      const env: Record<string, string> = { ...NON_INTERACTIVE_ENV };
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") {
          env[k] = v;
        }
      }
      if (args.env) {
        for (const [k, v] of Object.entries(args.env)) {
          if (v === null) {
            delete env[k];
          } else if (typeof v === "string") {
            env[k] = v;
          }
        }
      }
      const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
        cwd: args.cwd || process.cwd(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        callbacks.onOutput({ category: "stdout", output: chunk.toString("utf8") });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        callbacks.onOutput({ category: "stderr", output: chunk.toString("utf8") });
      });
      this.#spawnedTerminals.push(child);
      return { processId: child.pid };
    });
  }
}
