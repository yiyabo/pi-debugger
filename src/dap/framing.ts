/**
 * Byte-accurate UTF-8 Content-Length framing for the Debug Adapter Protocol.
 * Handles multi-byte UTF-8 payloads, fragmented headers/bodies across chunks,
 * coalesced frames, and stray non-DAP prefix lines on stdout.
 */

import type { DapWireMessage } from "../types.ts";

const HEADER_DELIMITER = Buffer.from("\r\n\r\n", "ascii");
const CONTENT_LENGTH_PREFIX = Buffer.from("Content-Length:", "ascii");
const MAX_FRAME_BYTES = 32 * 1024 * 1024; // 32 MiB safety guard

export function encodeDapMessage(message: DapWireMessage): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

export interface DapFrameCallbacks {
  onMessage: (message: DapWireMessage) => void;
  onStrayOutput?: (text: string) => void;
  onProtocolError?: (error: Error) => void;
}

export class DapFrameParser {
  #buffer: Buffer = Buffer.alloc(0);
  readonly #callbacks: DapFrameCallbacks;

  constructor(callbacks: DapFrameCallbacks) {
    this.#callbacks = callbacks;
  }

  push(chunk: Buffer | Uint8Array): void {
    if (chunk.length === 0) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? incoming : Buffer.concat([this.#buffer, incoming]);
    this.#drain();
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }

  #drain(): void {
    while (this.#buffer.length > 0) {
      // Check if stray stdout text precedes "Content-Length:"
      const clIndex = this.#indexOfCaseInsensitiveContentLength(this.#buffer);
      if (clIndex === -1) {
        // Wait if buffer might hold a partial "Content-Length:" prefix (< 32 bytes without newline)
        const newlineIdx = this.#buffer.indexOf(0x0a);
        if (newlineIdx === -1 && this.#buffer.length < 64) {
          return;
        }
        if (newlineIdx !== -1) {
          const stray = this.#buffer.subarray(0, newlineIdx + 1).toString("utf8");
          this.#buffer = this.#buffer.subarray(newlineIdx + 1);
          this.#callbacks.onStrayOutput?.(stray);
          continue;
        }
        return;
      }

      if (clIndex > 0) {
        const stray = this.#buffer.subarray(0, clIndex).toString("utf8");
        this.#buffer = this.#buffer.subarray(clIndex);
        if (stray.trim().length > 0) {
          this.#callbacks.onStrayOutput?.(stray);
        }
      }

      const headerEnd = this.#buffer.indexOf(HEADER_DELIMITER);
      if (headerEnd === -1) {
        if (this.#buffer.length > 8192) {
          const dropped = this.#buffer.toString("utf8");
          this.#buffer = Buffer.alloc(0);
          this.#callbacks.onProtocolError?.(new Error(`Oversized DAP header discarded: ${dropped.slice(0, 120)}`));
        }
        return;
      }

      const headerText = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        this.#callbacks.onProtocolError?.(new Error(`Missing Content-Length in DAP header: ${headerText}`));
        continue;
      }

      const contentLength = Number.parseInt(match[1], 10);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_FRAME_BYTES) {
        this.#buffer = Buffer.alloc(0);
        this.#callbacks.onProtocolError?.(new Error(`Invalid DAP Content-Length: ${match[1]}`));
        return;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.#buffer.length < bodyEnd) {
        return; // Wait for remaining payload bytes
      }

      const bodyText = this.#buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyEnd);

      try {
        const parsed = JSON.parse(bodyText) as DapWireMessage;
        this.#callbacks.onMessage(parsed);
      } catch (err) {
        this.#callbacks.onProtocolError?.(
          new Error(`Invalid JSON in DAP frame: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
  }

  #indexOfCaseInsensitiveContentLength(buf: Buffer): number {
    // Fast path for exact "Content-Length:"
    const exact = buf.indexOf(CONTENT_LENGTH_PREFIX);
    if (exact !== -1) return exact;
    const sample = buf.subarray(0, Math.min(buf.length, 4096)).toString("latin1");
    const m = sample.match(/content-length:/i);
    return m?.index ?? -1;
  }
}
