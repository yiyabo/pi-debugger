/**
 * Transport-agnostic DAP JSON-RPC client with request/response correlation,
 * AbortSignal + per-call timeouts, reverse request handling, and crash stderr surfacing.
 */

import type {
  DapCapabilities,
  DapEventMessage,
  DapRequestMessage,
  DapResponseMessage,
  DapWireMessage,
} from "../types.ts";
import type { DapTransport, DapTransportEvents } from "./transport.ts";

interface PendingRequest {
  command: string;
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
}

type EventListener = (body: unknown, raw: DapEventMessage) => void;
type ReverseRequestHandler = (args: unknown) => Promise<unknown> | unknown;

const DEFAULT_TIMEOUT_MS = 25_000;

export class DapProtocolClient {
  #transport!: DapTransport;
  #seq = 0;
  #disposed = false;
  #capabilities: DapCapabilities = {};
  readonly #pending = new Map<number, PendingRequest>();
  readonly #eventListeners = new Map<string, Set<EventListener>>();
  readonly #reverseHandlers = new Map<string, ReverseRequestHandler>();
  readonly #recentStderrEvents: string[] = [];

  private constructor() {}

  static async create(
    factory: (events: DapTransportEvents) => Promise<DapTransport> | DapTransport,
  ): Promise<DapProtocolClient> {
    const client = new DapProtocolClient();
    client.#transport = await factory({
      onMessage: (msg) => client.#handleMessage(msg),
      onClose: (info) => client.#handleClose(info),
    });
    return client;
  }

  get capabilities(): DapCapabilities {
    return this.#capabilities;
  }

  get pid(): number | undefined {
    return this.#transport.pid;
  }

  isAlive(): boolean {
    return !this.#disposed && this.#transport.isOpen();
  }

  onEvent(eventName: string, listener: EventListener): () => void {
    const set = this.#eventListeners.get(eventName) ?? new Set<EventListener>();
    set.add(listener);
    this.#eventListeners.set(eventName, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.#eventListeners.delete(eventName);
      }
    };
  }

  onReverseRequest(command: string, handler: ReverseRequestHandler): void {
    this.#reverseHandlers.set(command, handler);
  }

  async initialize(
    adapterID: string,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<DapCapabilities> {
    const caps = (await this.sendRequest(
      "initialize",
      {
        clientID: "pi-debugger",
        clientName: "pi-debugger",
        adapterID,
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsRunInTerminalRequest: true,
        supportsStartDebuggingRequest: true,
      },
      signal,
      timeoutMs,
    )) as DapCapabilities | undefined;
    this.#capabilities = caps ?? {};
    return this.#capabilities;
  }

  async sendRequest<T = unknown>(
    command: string,
    args?: unknown,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error(`DAP ${command} aborted`);
    }
    if (this.#disposed || !this.#transport.isOpen()) {
      throw new Error(this.#buildExitError(`DAP transport closed before '${command}'`));
    }

    const seq = ++this.#seq;
    const req: DapRequestMessage = {
      seq,
      type: "request",
      command,
      ...(args === undefined ? {} : { arguments: args }),
    };

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        this.#pending.delete(seq);
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error(`DAP ${command} aborted`));
      };

      const timer = setTimeout(() => {
        if (!this.#pending.has(seq)) {
          return;
        }
        this.#pending.delete(seq);
        cleanup();
        reject(new Error(this.#buildExitError(`DAP request '${command}' timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(seq, {
        command,
        resolve: (body) => {
          cleanup();
          resolve(body as T);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });

      this.#transport.send(req).catch((err) => {
        if (!this.#pending.has(seq)) {
          return;
        }
        this.#pending.delete(seq);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#rejectAll(new Error("DAP client disposed"));
    await this.#transport.close();
  }

  #handleMessage(msg: DapWireMessage): void {
    if (msg.type === "response") {
      this.#handleResponse(msg);
      return;
    }
    if (msg.type === "event") {
      this.#handleEvent(msg);
      return;
    }
    if (msg.type === "request") {
      void this.#handleReverseRequest(msg);
    }
  }

  #handleResponse(msg: DapResponseMessage): void {
    const pending = this.#pending.get(msg.request_seq);
    if (!pending) {
      return;
    }
    this.#pending.delete(msg.request_seq);
    if (msg.success) {
      pending.resolve(msg.body);
      return;
    }
    const bodyErr = (msg.body as { error?: { format?: string } } | undefined)?.error?.format;
    const detail = msg.message || bodyErr || `DAP '${pending.command}' failed`;
    pending.reject(new Error(detail));
  }

  #handleEvent(msg: DapEventMessage): void {
    if (msg.event === "output") {
      const body = msg.body as { category?: string; output?: string } | undefined;
      if (body?.category === "stderr" && typeof body.output === "string") {
        this.#recentStderrEvents.push(body.output);
        if (this.#recentStderrEvents.length > 60) {
          this.#recentStderrEvents.shift();
        }
      }
    }
    const listeners = this.#eventListeners.get(msg.event);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(msg.body, msg);
      } catch {
        // best-effort listener isolation
      }
    }
  }

  async #handleReverseRequest(msg: DapRequestMessage): Promise<void> {
    const handler = this.#reverseHandlers.get(msg.command);
    if (!handler) {
      await this.#sendResponse(msg, false, undefined, `Unsupported reverse request: ${msg.command}`);
      return;
    }
    try {
      const body = await handler(msg.arguments);
      await this.#sendResponse(msg, true, body ?? {});
    } catch (err) {
      await this.#sendResponse(msg, false, undefined, err instanceof Error ? err.message : String(err));
    }
  }

  async #sendResponse(req: DapRequestMessage, success: boolean, body?: unknown, message?: string): Promise<void> {
    if (!this.#transport.isOpen()) {
      return;
    }
    const resp: DapResponseMessage = {
      seq: ++this.#seq,
      type: "response",
      request_seq: req.seq,
      command: req.command,
      success,
      ...(body === undefined ? {} : { body }),
      ...(message ? { message } : {}),
    };
    try {
      await this.#transport.send(resp);
    } catch {
      // ignore if closing
    }
  }

  #handleClose(info: { exitCode?: number | null; signal?: string | null; stderr: string; error?: Error }): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const prefix = info.error
      ? `DAP adapter error: ${info.error.message}`
      : `DAP adapter exited unexpectedly (code=${String(info.exitCode ?? "null")}, signal=${String(info.signal ?? "none")})`;
    this.#rejectAll(new Error(this.#buildExitError(prefix, info.stderr)));
  }

  #buildExitError(prefix: string, extraDiag?: string): string {
    const parts = [
      extraDiag?.trim(),
      this.#transport.getDiagnostics(),
      this.#recentStderrEvents.join("").trim(),
    ].filter((s): s is string => Boolean(s && s.length > 0));
    if (parts.length === 0) {
      return prefix;
    }
    const merged = [...new Set(parts)].join("\n").slice(-2000);
    return `${prefix}\nAdapter diagnostics:\n${merged}`;
  }

  #rejectAll(err: Error): void {
    for (const p of this.#pending.values()) {
      p.reject(err);
    }
    this.#pending.clear();
  }
}
