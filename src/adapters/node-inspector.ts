/**
 * Zero-config built-in Node.js & TypeScript DebugBackend over V8 Inspector (CDP WebSocket).
 * Works out of the box on every machine running Pi (Node >= 22.6) with zero external downloads:
 *  - Launches .js/.mjs/.cjs/.ts/.mts/.cts scripts (auto-uses local tsx when available, else native Node)
 *  - Attaches to --inspect host:port
 *  - Attaches to ANY live running Node process by PID via process._debugProcess(pid) without restarting it!
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import type {
  DapCapabilities,
  DebugBackend,
  DebugBackendCallbacks,
  DebugEvaluateResult,
  DebugExceptionInfo,
  DebugScope,
  DebugStackFrame,
  DebugThread,
  DebugVariable,
  ResolvedAdapter,
  SourceBreakpointSpec,
  VerifiedBreakpoint,
  VerifiedFunctionBreakpoint,
} from "../types.ts";
import { NON_INTERACTIVE_ENV, isPidAlive, sleep, terminateProcessTree } from "../utils/process-tree.ts";
import { normalizeFileUrlOrPath } from "../utils/source-context.ts";

interface CdpCallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  url?: string;
  scopeChain: Array<{
    type: string;
    name?: string;
    object: { type: string; objectId?: string; className?: string; description?: string };
  }>;
}

interface CdpRemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: {
    properties?: Array<{ name: string; type: string; value?: string; subtype?: string }>;
    overflow?: boolean;
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function logMessageToCondition(logMessage: string): string {
  // Convert DAP logpoint template "count={count}" into JS console.log("count=" + (count)) && false
  const parts: string[] = [];
  let lastIdx = 0;
  const regex = /\{([^}]+)\}/g;
  let match = regex.exec(logMessage);
  while (match !== null) {
    if (match.index > lastIdx) {
      parts.push(JSON.stringify(logMessage.slice(lastIdx, match.index)));
    }
    parts.push(`String(${match[1]})`);
    lastIdx = match.index + match[0].length;
    match = regex.exec(logMessage);
  }
  if (lastIdx < logMessage.length) {
    parts.push(JSON.stringify(logMessage.slice(lastIdx)));
  }
  const joined = parts.length > 0 ? parts.join(" + ") : JSON.stringify(logMessage);
  return `(console.log(${joined}), false)`;
}

function formatRemoteObject(obj: CdpRemoteObject | undefined): string {
  if (!obj) {
    return "undefined";
  }
  if (obj.type === "undefined") {
    return "undefined";
  }
  if (obj.subtype === "null") {
    return "null";
  }
  if (obj.type === "string") {
    return JSON.stringify(obj.value);
  }
  if (obj.unserializableValue) {
    return obj.unserializableValue;
  }
  if (obj.value !== undefined) {
    return String(obj.value);
  }
  if (obj.preview?.properties) {
    const isArray = obj.subtype === "array";
    const props = obj.preview.properties.map((p) => {
      const val = p.type === "string" ? JSON.stringify(p.value ?? "") : (p.value ?? p.type);
      return isArray ? val : `${p.name}: ${val}`;
    });
    const suffix = obj.preview.overflow ? ", ..." : "";
    return isArray ? `[${props.join(", ")}${suffix}]` : `{${props.join(", ")}${suffix}}`;
  }
  return obj.description ?? obj.className ?? obj.type;
}

async function fetchInspectorWsUrl(host: string, port: number, timeoutMs = 2000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = http.get({ host, port, path: "/json/list", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body = `${body}${chunk}`;
      });
      res.on("end", () => {
        try {
          const list = JSON.parse(body) as Array<{ webSocketDebuggerUrl?: string }>;
          const wsUrl = list[0]?.webSocketDebuggerUrl;
          if (wsUrl) {
            resolve(wsUrl);
          } else {
            reject(new Error(`No inspectable target returned from http://${host}:${port}/json/list`));
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout querying http://${host}:${port}/json/list`));
    });
  });
}

export class NodeInspectorBackend implements DebugBackend {
  readonly adapter: ResolvedAdapter;
  readonly capabilities: DapCapabilities = {
    supportsConfigurationDoneRequest: true,
    supportsConditionalBreakpoints: true,
    supportsLogPoints: true,
    supportsEvaluateForHovers: true,
    supportsExceptionInfoRequest: true,
    supportTerminateDebuggee: true,
    exceptionBreakpointFilters: [
      { filter: "uncaught", label: "Uncaught Exceptions", default: true },
      { filter: "all", label: "All Exceptions (Caught & Uncaught)", default: false },
    ],
  };

  readonly #callbacks: DebugBackendCallbacks;
  #proc?: ChildProcess;
  #detachedGroup = false;
  #ws?: WebSocket;
  #disposed = false;
  #seq = 0;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #scripts = new Map<string, string>(); // scriptId -> filesystem path or URL
  readonly #bpIdsByFile = new Map<string, string[]>();
  #callFrames: CdpCallFrame[] = [];
  readonly #frameById = new Map<number, CdpCallFrame>();
  #nextVarRef = 1;
  readonly #objectByVarRef = new Map<number, string>();
  #lastException?: DebugExceptionInfo;
  #suppressInitialBrkPause = false;

  constructor(adapter: ResolvedAdapter, callbacks: DebugBackendCallbacks) {
    this.adapter = adapter;
    this.#callbacks = callbacks;
  }

  isAlive(): boolean {
    if (this.#disposed) {
      return false;
    }
    if (this.#proc && this.#proc.exitCode !== null) {
      return false;
    }
    return this.#ws?.readyState === WebSocket.OPEN;
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
    timeoutMs = 20_000,
  ): Promise<{ verifiedBreakpoints: VerifiedBreakpoint[]; verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[] }> {
    const ext = path.extname(opts.program).toLowerCase();
    const isTs = ext === ".ts" || ext === ".mts" || ext === ".cts" || ext === ".tsx";
    const localTsx = path.join(opts.cwd, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const useTsx = isTs && fs.existsSync(localTsx);

    const runtimeArgs = Array.isArray(opts.launchArgs?.runtimeArgs)
      ? (opts.launchArgs.runtimeArgs as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    const cmd = useTsx ? localTsx : process.execPath;
    const spawnArgs = [
      "--inspect-brk=127.0.0.1:0",
      ...runtimeArgs,
      opts.program,
      ...(opts.args ?? []),
    ];

    this.#detachedGroup = process.platform !== "win32";
    const proc = spawn(cmd, spawnArgs, {
      cwd: opts.cwd,
      detached: this.#detachedGroup,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...NON_INTERACTIVE_ENV,
        ...opts.env,
      },
    });
    this.#proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      this.#callbacks.onOutput({ category: "stdout", output: chunk.toString("utf8") });
    });

    const wsUrl = await new Promise<string>((resolve, reject) => {
      let stderrAcc = "";
      let resolved = false;
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for Node V8 Inspector URL. stderr: ${stderrAcc.trim()}`));
      }, timeoutMs);

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrAcc = `${stderrAcc}${text}`;
        const match = stderrAcc.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+/i);
        if (!resolved && match) {
          resolved = true;
          clearTimeout(timer);
          resolve(match[0]);
          return;
        }
        // Forward user stderr excluding Node's standard Debugger listening banner
        if (!text.includes("Debugger listening on ws://") && !text.includes("For help, see: https://nodejs.org/en/docs/inspector")) {
          this.#callbacks.onOutput({ category: "stderr", output: text });
        }
      });

      proc.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.once("exit", (code) => {
        if (!resolved) {
          clearTimeout(timer);
          reject(new Error(`Node exited before inspector attached (code=${String(code)}): ${stderrAcc.trim()}`));
        }
      });
    });

    proc.once("exit", (code) => {
      this.#callbacks.onExited(code ?? 0);
      this.#callbacks.onTerminated();
      void this.dispose();
    });

    await this.#connectWebSocket(wsUrl, timeoutMs);
    await this.#cdp("Runtime.enable", {}, signal, timeoutMs);
    await this.#cdp("Debugger.enable", {}, signal, timeoutMs);

    const verifiedBreakpoints: VerifiedBreakpoint[] = [];
    for (const [file, specs] of opts.initialBreakpoints.entries()) {
      if (specs.length > 0) {
        const res = await this.setSourceBreakpoints(file, specs, signal, timeoutMs);
        verifiedBreakpoints.push(...res);
      }
    }

    const filters = opts.exceptionFilters ?? ["uncaught"];
    await this.setExceptionBreakpoints(filters, signal, timeoutMs);

    // Determine whether we should auto-skip Node's internal --inspect-brk pause on line 1
    const realProgram = this.#safeRealpath(opts.program);
    const hasLine1Bp = [...opts.initialBreakpoints.entries()].some(([f, specs]) => {
      return this.#safeRealpath(f) === realProgram && specs.some((s) => s.line <= 1);
    });
    this.#suppressInitialBrkPause = !opts.stopOnEntry && !hasLine1Bp;

    await this.#cdp("Runtime.runIfWaitingForDebugger", {}, signal, timeoutMs);
    return { verifiedBreakpoints, verifiedFunctionBreakpoints: [] };
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
    timeoutMs = 15_000,
  ): Promise<{ verifiedBreakpoints: VerifiedBreakpoint[]; verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[] }> {
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 9229;

    if (opts.pid !== undefined) {
      if (!isPidAlive(opts.pid)) {
        throw new Error(`Process PID ${opts.pid} is not running`);
      }
      // Activate V8 Inspector in live Node process (sends SIGUSR1 / Windows debug signal)
      if (process._debugProcess) {
        process._debugProcess(opts.pid);
      } else {
        process.kill(opts.pid, "SIGUSR1");
      }
    }

    let wsUrl: string | undefined;
    const deadline = Date.now() + Math.min(timeoutMs, 5_000);
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        wsUrl = await fetchInspectorWsUrl(host, port, 1000);
        break;
      } catch (err) {
        lastErr = err;
        await sleep(120);
      }
    }
    if (!wsUrl) {
      throw new Error(
        `Could not discover Node V8 Inspector at ${host}:${port}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
    }

    await this.#connectWebSocket(wsUrl, timeoutMs);
    await this.#cdp("Runtime.enable", {}, signal, timeoutMs);
    await this.#cdp("Debugger.enable", {}, signal, timeoutMs);

    const verifiedBreakpoints: VerifiedBreakpoint[] = [];
    for (const [file, specs] of opts.initialBreakpoints.entries()) {
      if (specs.length > 0) {
        const res = await this.setSourceBreakpoints(file, specs, signal, timeoutMs);
        verifiedBreakpoints.push(...res);
      }
    }

    if (opts.exceptionFilters !== undefined) {
      await this.setExceptionBreakpoints(opts.exceptionFilters, signal, timeoutMs);
    }

    await this.#cdp("Runtime.runIfWaitingForDebugger", {}, signal, timeoutMs).catch(() => {});

    // When attaching without specific breakpoints, pause immediately so the agent sees live state!
    const pauseOnAttach = opts.attachArgs?.pauseOnAttach !== false && verifiedBreakpoints.length === 0;
    if (pauseOnAttach && this.#callFrames.length === 0) {
      await this.#cdp("Debugger.pause", {}, signal, timeoutMs).catch(() => {});
    }

    return { verifiedBreakpoints, verifiedFunctionBreakpoints: [] };
  }

  async setSourceBreakpoints(
    file: string,
    specs: SourceBreakpointSpec[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<VerifiedBreakpoint[]> {
    const realFile = this.#safeRealpath(file);
    const existingIds = this.#bpIdsByFile.get(realFile) ?? [];
    for (const bpId of existingIds) {
      await this.#cdp("Debugger.removeBreakpoint", { breakpointId: bpId }, signal, timeoutMs).catch(() => {});
    }
    this.#bpIdsByFile.delete(realFile);

    const newIds: string[] = [];
    const results: VerifiedBreakpoint[] = [];
    const urlCandidates = new Set([
      realFile,
      path.resolve(file),
      pathToFileURL(realFile).href,
      pathToFileURL(path.resolve(file)).href,
    ]);
    const urlRegex = `^(${[...urlCandidates].map(escapeRegex).join("|")})$`;

    for (const spec of specs) {
      const line0 = Math.max(0, spec.line - 1);
      const condition = spec.logMessage
        ? logMessageToCondition(spec.logMessage)
        : spec.condition;

      const resp = await this.#cdp<{
        breakpointId: string;
        locations?: Array<{ lineNumber: number; columnNumber?: number }>;
      }>(
        "Debugger.setBreakpointByUrl",
        {
          urlRegex,
          lineNumber: line0,
          ...(spec.column === undefined ? {} : { columnNumber: Math.max(0, spec.column - 1) }),
          ...(condition ? { condition } : {}),
        },
        signal,
        timeoutMs,
      );

      newIds.push(resp.breakpointId);
      const loc = resp.locations?.[0];
      results.push({
        verified: true,
        file: realFile,
        line: loc ? loc.lineNumber + 1 : spec.line,
        requestedLine: spec.line,
        column: loc?.columnNumber === undefined ? spec.column : loc.columnNumber + 1,
        condition: spec.condition,
        logMessage: spec.logMessage,
      });
    }

    this.#bpIdsByFile.set(realFile, newIds);
    return results;
  }

  async setFunctionBreakpoints(): Promise<VerifiedFunctionBreakpoint[]> {
    return [];
  }

  async setExceptionBreakpoints(filters: string[], signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    let state: "none" | "uncaught" | "all" = "none";
    if (filters.includes("all") || filters.includes("raised")) {
      state = "all";
    } else if (filters.includes("uncaught")) {
      state = "uncaught";
    }
    await this.#cdp("Debugger.setPauseOnExceptions", { state }, signal, timeoutMs);
  }

  async continueExecution(_threadId?: number, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#cdp("Debugger.resume", {}, signal, timeoutMs);
  }

  async pauseExecution(_threadId?: number, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#cdp("Debugger.pause", {}, signal, timeoutMs);
  }

  async stepOver(_threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#cdp("Debugger.stepOver", {}, signal, timeoutMs);
  }

  async stepIn(_threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#cdp("Debugger.stepInto", {}, signal, timeoutMs);
  }

  async stepOut(_threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    await this.#cdp("Debugger.stepOut", {}, signal, timeoutMs);
  }

  async threads(): Promise<DebugThread[]> {
    return [{ id: 1, name: "MainThread (V8)" }];
  }

  async stackTrace(_threadId: number, levels = 20): Promise<DebugStackFrame[]> {
    const frames: DebugStackFrame[] = [];
    const slice = this.#callFrames.slice(0, levels);
    for (let i = 0; i < slice.length; i++) {
      const cf = slice[i];
      const frameId = i + 1;
      this.#frameById.set(frameId, cf);
      const rawUrl = cf.url || this.#scripts.get(cf.location.scriptId);
      const fsPath = normalizeFileUrlOrPath(rawUrl);
      frames.push({
        id: frameId,
        name: cf.functionName || "(anonymous)",
        source: fsPath
          ? { path: fsPath, name: path.basename(fsPath) }
          : undefined,
        line: cf.location.lineNumber + 1,
        column: (cf.location.columnNumber ?? 0) + 1,
      });
    }
    return frames;
  }

  async scopes(frameId: number): Promise<DebugScope[]> {
    const cf = this.#frameById.get(frameId) ?? this.#callFrames[frameId - 1] ?? this.#callFrames[0];
    if (!cf) {
      return [];
    }
    const scopes: DebugScope[] = [];
    for (const sc of cf.scopeChain) {
      if (!sc.object.objectId) {
        continue;
      }
      const varRef = this.#registerObjectId(sc.object.objectId);
      const title = sc.name ? `${sc.type} (${sc.name})` : sc.type;
      scopes.push({
        name: title,
        variablesReference: varRef,
        expensive: sc.type === "global",
      });
    }
    return scopes;
  }

  async variables(variablesReference: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugVariable[]> {
    const objectId = this.#objectByVarRef.get(variablesReference);
    if (!objectId) {
      return [];
    }
    const resp = await this.#cdp<{
      result?: Array<{
        name: string;
        value?: CdpRemoteObject;
        enumerable?: boolean;
      }>;
    }>(
      "Runtime.getProperties",
      {
        objectId,
        ownProperties: true,
        generatePreview: true,
      },
      signal,
      timeoutMs,
    );

    const out: DebugVariable[] = [];
    for (const prop of resp.result ?? []) {
      if (prop.name === "__proto__" || !prop.value) {
        continue;
      }
      const valObj = prop.value;
      const childRef = valObj.objectId && valObj.type === "object" && valObj.subtype !== "null"
        ? this.#registerObjectId(valObj.objectId)
        : 0;
      out.push({
        name: prop.name,
        value: formatRemoteObject(valObj),
        type: valObj.subtype ?? valObj.className ?? valObj.type,
        variablesReference: childRef,
      });
    }
    return out;
  }

  async evaluate(
    expression: string,
    frameId?: number,
    _context?: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<DebugEvaluateResult> {
    const targetFrame = frameId === undefined
      ? this.#callFrames[0]
      : (this.#frameById.get(frameId) ?? this.#callFrames[frameId - 1] ?? this.#callFrames[0]);

    try {
      const resp = targetFrame
        ? await this.#cdp<{
            result: CdpRemoteObject;
            exceptionDetails?: { text?: string; exception?: CdpRemoteObject };
          }>(
            "Debugger.evaluateOnCallFrame",
            {
              callFrameId: targetFrame.callFrameId,
              expression,
              generatePreview: true,
              returnByValue: false,
            },
            signal,
            timeoutMs,
          )
        : await this.#cdp<{
            result: CdpRemoteObject;
            exceptionDetails?: { text?: string; exception?: CdpRemoteObject };
          }>(
            "Runtime.evaluate",
            {
              expression,
              generatePreview: true,
              returnByValue: false,
            },
            signal,
            timeoutMs,
          );

      if (resp.exceptionDetails) {
        const errMsg = resp.exceptionDetails.exception
          ? formatRemoteObject(resp.exceptionDetails.exception)
          : (resp.exceptionDetails.text ?? "Evaluation threw an exception");
        return {
          expression,
          result: "",
          variablesReference: 0,
          error: errMsg,
        };
      }

      const childRef = resp.result.objectId && resp.result.type === "object" && resp.result.subtype !== "null"
        ? this.#registerObjectId(resp.result.objectId)
        : 0;
      return {
        expression,
        result: formatRemoteObject(resp.result),
        type: resp.result.subtype ?? resp.result.className ?? resp.result.type,
        variablesReference: childRef,
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

  async exceptionInfo(): Promise<DebugExceptionInfo | undefined> {
    return this.#lastException;
  }

  async disconnect(opts: { terminateDebuggee: boolean }, signal?: AbortSignal, timeoutMs = 3_000): Promise<void> {
    if (!opts.terminateDebuggee && this.#ws?.readyState === WebSocket.OPEN) {
      // Polite detach from live attached Node process without terminating it!
      await this.#cdp("Debugger.disable", {}, signal, timeoutMs).catch(() => {});
      await this.#cdp("Runtime.disable", {}, signal, timeoutMs).catch(() => {});
    }
    if (opts.terminateDebuggee && this.#proc) {
      await terminateProcessTree(this.#proc, { detachedGroup: this.#detachedGroup });
    }
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const p of this.#pending.values()) {
      p.reject(new Error("Node V8 Inspector disposed"));
    }
    this.#pending.clear();
    try {
      this.#ws?.close();
    } catch {
      // ignore
    }
    if (this.#proc) {
      await terminateProcessTree(this.#proc, { detachedGroup: this.#detachedGroup });
    }
  }

  async #connectWebSocket(wsUrl: string, timeoutMs: number): Promise<void> {
    const ws = new WebSocket(wsUrl);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to V8 Inspector WebSocket ${wsUrl}`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Failed connecting to V8 Inspector WebSocket ${wsUrl}`));
      }, { once: true });
    });

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
          method?: string;
          params?: Record<string, unknown>;
        };
        if (msg.id !== undefined) {
          const pending = this.#pending.get(msg.id);
          if (pending) {
            this.#pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message ?? "CDP error"));
            } else {
              pending.resolve(msg.result);
            }
          }
          return;
        }
        if (msg.method) {
          this.#handleCdpEvent(msg.method, msg.params ?? {});
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.addEventListener("close", () => {
      if (!this.#disposed && !this.#proc) {
        this.#callbacks.onTerminated();
      }
    });
  }

  #handleCdpEvent(method: string, params: Record<string, unknown>): void {
    if (method === "Debugger.scriptParsed") {
      const scriptId = params.scriptId as string | undefined;
      const url = params.url as string | undefined;
      if (scriptId && url) {
        this.#scripts.set(scriptId, url);
      }
      return;
    }

    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type ?? "log");
      const args = Array.isArray(params.args) ? (params.args as CdpRemoteObject[]) : [];
      const line = `${args.map(formatRemoteObject).join(" ")}\n`;
      this.#callbacks.onOutput({
        category: type === "error" || type === "warning" ? "stderr" : "stdout",
        output: line,
      });
      return;
    }

    if (method === "Debugger.resumed") {
      this.#callFrames = [];
      this.#frameById.clear();
      this.#objectByVarRef.clear();
      this.#lastException = undefined;
      this.#callbacks.onContinued(1);
      return;
    }

    if (method === "Debugger.paused") {
      const frames = Array.isArray(params.callFrames) ? (params.callFrames as CdpCallFrame[]) : [];
      const rawReason = String(params.reason ?? "other");
      const hitBreakpoints = Array.isArray(params.hitBreakpoints) ? (params.hitBreakpoints as string[]) : [];

      if (this.#suppressInitialBrkPause) {
        this.#suppressInitialBrkPause = false;
        if (hitBreakpoints.length === 0 && rawReason !== "exception" && rawReason !== "promiseRejection") {
          void this.#cdp("Debugger.resume").catch(() => {});
          return;
        }
      }

      this.#callFrames = frames;
      this.#frameById.clear();
      this.#objectByVarRef.clear();

      let normalizedReason = "step";
      let description: string | undefined;
      if (rawReason === "exception" || rawReason === "promiseRejection") {
        normalizedReason = "exception";
        const data = params.data as CdpRemoteObject | undefined;
        const desc = formatRemoteObject(data);
        description = desc;
        this.#lastException = {
          exceptionId: data?.className ?? "Error",
          description: desc,
          details: {
            message: desc,
            typeName: data?.className,
          },
        };
      } else if (hitBreakpoints.length > 0 || rawReason === "Break on start") {
        normalizedReason = rawReason === "Break on start" ? "entry" : "breakpoint";
        this.#lastException = undefined;
      } else if (rawReason === "debugCommand" || rawReason === "ambiguous") {
        normalizedReason = "pause";
      }

      this.#callbacks.onStopped({
        reason: normalizedReason,
        description,
        threadId: 1,
        allThreadsStopped: true,
      });
    }
  }

  #registerObjectId(objectId: string): number {
    const id = this.#nextVarRef++;
    this.#objectByVarRef.set(id, objectId);
    return id;
  }

  #safeRealpath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }

  async #cdp<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<T> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error(`CDP ${method} aborted`);
    }
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`V8 Inspector WebSocket is not open for ${method}`);
    }

    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`V8 Inspector '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error(`CDP ${method} aborted`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(val as T); // SAFETY: CDP result shape matches command-specific generic T
        },
        reject: (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });

      ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
