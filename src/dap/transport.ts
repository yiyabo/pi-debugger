/**
 * Unified DAP transports:
 *  - StdioDapTransport: spawns adapter subprocess speaking DAP over stdin/stdout
 *  - TcpDapTransport: connects directly to host:port OR spawns a socket-mode adapter
 *    (e.g. dlv dap --listen=127.0.0.1:0, codelldb --port 0, debugpy --listen)
 *    and discovers its bound port from stdout/stderr before connecting TCP.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import type { DapWireMessage } from "../types.ts";
import { DapFrameParser, encodeDapMessage } from "./framing.ts";
import { NON_INTERACTIVE_ENV, terminateProcessTree } from "../utils/process-tree.ts";

export interface DapTransportEvents {
  onMessage: (message: DapWireMessage) => void;
  onDiagnosticOutput?: (text: string) => void;
  onClose: (reason: { exitCode?: number | null; signal?: string | null; stderr: string; error?: Error }) => void;
}

export interface DapTransport {
  readonly pid?: number;
  isOpen(): boolean;
  send(message: DapWireMessage): Promise<void>;
  getDiagnostics(): string;
  close(): Promise<void>;
}

const PORT_PATTERNS = [
  /DAP server listening at:\s*([^\s:]+):(\d+)/i,
  /Listening on(?:\s+port)?\s*(?:127\.0\.0\.1:|localhost:|:)?(\d+)/i,
  /127\.0\.0\.1:(\d+)/,
  /localhost:(\d+)/i,
];

function extractHostPort(text: string): { host: string; port: number } | null {
  for (const regex of PORT_PATTERNS) {
    const match = text.match(regex);
    if (!match) {
      continue;
    }
    if (match.length === 3) {
      const port = Number.parseInt(match[2], 10);
      if (port > 0 && port <= 65535) {
        const host = match[1] === "[::]" || match[1] === "0.0.0.0" ? "127.0.0.1" : match[1];
        return { host, port };
      }
    } else if (match.length === 2) {
      const port = Number.parseInt(match[1], 10);
      if (port > 0 && port <= 65535) {
        return { host: "127.0.0.1", port };
      }
    }
  }
  return null;
}

export class StdioDapTransport implements DapTransport {
  readonly #proc: ChildProcess;
  readonly #detachedGroup: boolean;
  readonly #stderrChunks: string[] = [];
  #closed = false;

  constructor(proc: ChildProcess, detachedGroup: boolean, events: DapTransportEvents) {
    this.#proc = proc;
    this.#detachedGroup = detachedGroup;

    const parser = new DapFrameParser({
      onMessage: (msg) => events.onMessage(msg),
      onStrayOutput: (stray) => {
        this.#appendDiag(stray);
        events.onDiagnosticOutput?.(stray);
      },
      onProtocolError: (err) => {
        this.#appendDiag(`[protocol] ${err.message}\n`);
      },
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      parser.push(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.#appendDiag(text);
      events.onDiagnosticOutput?.(text);
    });

    proc.once("error", (err) => {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      events.onClose({ stderr: this.getDiagnostics(), error: err });
    });

    proc.once("exit", (exitCode, signal) => {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      events.onClose({ exitCode, signal, stderr: this.getDiagnostics() });
    });
  }

  static spawn(opts: {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    events: DapTransportEvents;
  }): StdioDapTransport {
    const detachedGroup = process.platform !== "win32";
    const proc = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      detached: detachedGroup,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...NON_INTERACTIVE_ENV,
        ...(opts.env ?? {}),
      },
    });
    return new StdioDapTransport(proc, detachedGroup, opts.events);
  }

  get pid(): number | undefined {
    return this.#proc.pid;
  }

  isOpen(): boolean {
    return !this.#closed && this.#proc.exitCode === null && Boolean(this.#proc.stdin?.writable);
  }

  async send(message: DapWireMessage): Promise<void> {
    const stdin = this.#proc.stdin;
    if (!this.isOpen() || !stdin) {
      throw new Error("DAP stdio transport is closed");
    }
    const frame = encodeDapMessage(message);
    await new Promise<void>((resolve, reject) => {
      stdin.write(frame, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  getDiagnostics(): string {
    return this.#stderrChunks.join("").trim();
  }

  async close(): Promise<void> {
    this.#closed = true;
    try {
      this.#proc.stdin?.end();
    } catch {
      // ignore
    }
    await terminateProcessTree(this.#proc, { detachedGroup: this.#detachedGroup });
  }

  #appendDiag(text: string): void {
    this.#stderrChunks.push(text);
    if (this.#stderrChunks.length > 120) {
      this.#stderrChunks.shift();
    }
  }
}

export class TcpDapTransport implements DapTransport {
  readonly #socket: net.Socket;
  readonly #proc?: ChildProcess;
  readonly #detachedGroup: boolean;
  readonly #diagChunks: string[];
  #closed = false;

  private constructor(
    socket: net.Socket,
    events: DapTransportEvents,
    proc?: ChildProcess,
    detachedGroup = false,
    initialDiag: string[] = [],
  ) {
    this.#socket = socket;
    this.#proc = proc;
    this.#detachedGroup = detachedGroup;
    this.#diagChunks = [...initialDiag];

    const parser = new DapFrameParser({
      onMessage: (msg) => events.onMessage(msg),
      onStrayOutput: (stray) => {
        this.#appendDiag(stray);
        events.onDiagnosticOutput?.(stray);
      },
      onProtocolError: (err) => {
        this.#appendDiag(`[protocol] ${err.message}\n`);
      },
    });

    socket.on("data", (chunk: Buffer) => {
      parser.push(chunk);
    });

    socket.once("error", (err) => {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      events.onClose({ stderr: this.getDiagnostics(), error: err });
    });

    socket.once("close", () => {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      events.onClose({
        exitCode: this.#proc?.exitCode,
        stderr: this.getDiagnostics(),
      });
    });

    if (proc) {
      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.#appendDiag(text);
        events.onDiagnosticOutput?.(text);
      });
      proc.once("exit", (exitCode, signal) => {
        if (this.#closed) {
          return;
        }
        this.#closed = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        events.onClose({ exitCode, signal, stderr: this.getDiagnostics() });
      });
    }
  }

  static async connect(opts: {
    host: string;
    port: number;
    timeoutMs?: number;
    events: DapTransportEvents;
  }): Promise<TcpDapTransport> {
    const socket = await TcpDapTransport.#openSocket(opts.host, opts.port, opts.timeoutMs ?? 10_000);
    return new TcpDapTransport(socket, opts.events);
  }

  static async spawnAndConnect(opts: {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    events: DapTransportEvents;
  }): Promise<TcpDapTransport> {
    const detachedGroup = process.platform !== "win32";
    const proc = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      detached: detachedGroup,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...NON_INTERACTIVE_ENV,
        ...(opts.env ?? {}),
      },
    });

    const diag: string[] = [];
    try {
      const endpoint = await new Promise<{ host: string; port: number }>((resolve, reject) => {
        let combined = "";
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for DAP TCP adapter '${opts.command}' to announce port. Output: ${combined.trim()}`));
        }, opts.timeoutMs ?? 12_000);

        const onChunk = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          diag.push(text);
          combined = `${combined}${text}`;
          const found = extractHostPort(combined);
          if (found) {
            clearTimeout(timer);
            proc.stdout?.off("data", onChunk);
            proc.stderr?.off("data", onChunk);
            resolve(found);
          }
        };

        proc.stdout?.on("data", onChunk);
        proc.stderr?.on("data", onChunk);
        proc.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`DAP TCP adapter '${opts.command}' exited early (code ${String(code)}): ${combined.trim()}`));
        });
      });

      const socket = await TcpDapTransport.#openSocket(endpoint.host, endpoint.port, opts.timeoutMs ?? 10_000);
      return new TcpDapTransport(socket, opts.events, proc, detachedGroup, diag);
    } catch (err) {
      await terminateProcessTree(proc, { detachedGroup });
      throw err;
    }
  }

  static async #openSocket(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to DAP TCP server at ${host}:${port}`));
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(socket);
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  get pid(): number | undefined {
    return this.#proc?.pid;
  }

  isOpen(): boolean {
    return !this.#closed && !this.#socket.destroyed && this.#socket.writable;
  }

  async send(message: DapWireMessage): Promise<void> {
    if (!this.isOpen()) {
      throw new Error("DAP TCP transport is closed");
    }
    const frame = encodeDapMessage(message);
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(frame, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  getDiagnostics(): string {
    return this.#diagChunks.join("").trim();
  }

  async close(): Promise<void> {
    this.#closed = true;
    try {
      this.#socket.end();
      this.#socket.destroy();
    } catch {
      // ignore
    }
    if (this.#proc) {
      await terminateProcessTree(this.#proc, { detachedGroup: this.#detachedGroup });
    }
  }

  #appendDiag(text: string): void {
    this.#diagChunks.push(text);
    if (this.#diagChunks.length > 120) {
      this.#diagChunks.shift();
    }
  }
}
