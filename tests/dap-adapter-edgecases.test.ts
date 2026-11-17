import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { DebugSessionManager } from "../src/session-manager.ts";

/**
 * Writes a tiny synthetic DAP server in Node.js to exercise native/compiled DAP adapter behaviors:
 * - "tcp-spawn" mode (`DAP server listening at: 127.0.0.1:<port>` like Go Delve `dlv dap` / `codelldb`)
 * - emitting `initialized` BEFORE responding to `launch`
 * - `disassemble`, `readMemory`, and `custom` DAP requests
 * - crash-on-launch with `output(stderr)` stacktrace diagnostics (regression test for lldb-dap crashes)
 */
function writeSyntheticDapServer(dir: string): string {
  const serverPath = path.join(dir, "synthetic-dap.mjs");
  const code = `
import * as net from "node:net";

const mode = process.argv[2] || "tcp";

function encode(msg) {
  const json = JSON.stringify(msg);
  return Buffer.concat([
    Buffer.from("Content-Length: " + Buffer.byteLength(json, "utf8") + "\\r\\n\\r\\n", "ascii"),
    Buffer.from(json, "utf8"),
  ]);
}

function attachStream(inStream, outStream) {
  let buf = Buffer.alloc(0);
  let seq = 1;
  const send = (obj) => outStream.write(encode({ seq: seq++, ...obj }));

  inStream.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const idx = buf.indexOf("\\r\\n\\r\\n");
      if (idx === -1) return;
      const header = buf.subarray(0, idx).toString("ascii");
      const m = header.match(/Content-Length:\\s*(\\d+)/i);
      const len = Number(m[1]);
      if (buf.length < idx + 4 + len) return;
      const body = JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString("utf8"));
      buf = buf.subarray(idx + 4 + len);
      handle(body, send);
    }
  });
}

function handle(req, send) {
  const reply = (body = {}) => send({ type: "response", request_seq: req.seq, success: true, command: req.command, body });

  if (req.command === "initialize") {
    reply({
      supportsConfigurationDoneRequest: true,
      supportsDisassembleRequest: true,
      supportsReadMemoryRequest: true,
    });
    // Emit initialized BEFORE launch (Go dlv / codelldb ordering!)
    send({ type: "event", event: "initialized", body: {} });
    return;
  }

  if (req.command === "launch") {
    if (mode === "crash") {
      send({ type: "event", event: "output", body: { category: "stderr", output: "FATAL: synthetic symbol table crash in ParseSymtab\\n" } });
      setTimeout(() => process.exit(139), 20);
      return;
    }
    reply({});
    return;
  }

  if (req.command === "setBreakpoints") {
    const bps = (req.arguments?.breakpoints || []).map((bp) => ({
      verified: true,
      line: bp.line,
    }));
    reply({ breakpoints: bps });
    return;
  }

  if (req.command === "setFunctionBreakpoints") {
    reply({ breakpoints: [] });
    return;
  }

  if (req.command === "setExceptionBreakpoints") {
    reply({});
    return;
  }

  if (req.command === "configurationDone") {
    reply({});
    send({
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 7, allThreadsStopped: true },
    });
    return;
  }

  if (req.command === "threads") {
    reply({ threads: [{ id: 7, name: "goroutine 1" }] });
    return;
  }

  if (req.command === "stackTrace") {
    reply({
      stackFrames: [
        {
          id: 101,
          name: "main.compute",
          line: 12,
          column: 1,
          instructionPointerReference: "0x100004000",
        },
      ],
    });
    return;
  }

  if (req.command === "scopes") {
    reply({ scopes: [{ name: "Locals", variablesReference: 500, expensive: false }] });
    return;
  }

  if (req.command === "variables") {
    reply({ variables: [{ name: "answer", value: "42", type: "int", variablesReference: 0 }] });
    return;
  }

  if (req.command === "disassemble") {
    reply({
      instructions: [
        { address: "0x100004000", instructionBytes: "fd 7b bf a9", instruction: "stp x29, x30, [sp, #-16]!" },
        { address: "0x100004004", instructionBytes: "fd 03 00 91", instruction: "mov x29, sp" },
      ],
    });
    return;
  }

  if (req.command === "readMemory") {
    reply({
      address: req.arguments?.memoryReference || "0x100004000",
      data: Buffer.from("HelloDAP", "utf8").toString("base64"),
      unreadableBytes: 0,
    });
    return;
  }

  if (req.command === "customEcho") {
    reply({ echoed: req.arguments });
    return;
  }

  if (req.command === "disconnect") {
    reply({});
    setTimeout(() => process.exit(0), 10);
    return;
  }

  reply({});
}

if (mode === "tcp") {
  const srv = net.createServer((sock) => attachStream(sock, sock));
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    process.stdout.write("DAP server listening at: 127.0.0.1:" + addr.port + "\\n");
  });
} else {
  attachStream(process.stdin, process.stdout);
}
`;
  fs.writeFileSync(serverPath, code, "utf8");
  return serverPath;
}

describe("Native/TCP DAP protocol edge cases", () => {
  const managers: DebugSessionManager[] = [];

  afterEach(async () => {
    while (managers.length > 0) {
      const m = managers.pop();
      if (m) {
        await m.disposeAll();
      }
    }
  });

  it("supports tcp-spawn DAP servers (dlv/codelldb style), early initialized event, disassemble, memory, and custom requests", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-dap-edge-"));
    try {
      const serverPath = writeSyntheticDapServer(tmp);
      const binPath = path.join(tmp, "app.bin");
      fs.writeFileSync(binPath, "fake-binary", "utf8");

      fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".pi", "dap.json"),
        JSON.stringify({
          adapters: {
            synth: {
              command: process.execPath,
              args: [serverPath, "tcp"],
              transport: "tcp-spawn",
              languages: ["go", "rust"],
              fileExtensions: [".bin"],
            },
          },
        }),
        "utf8",
      );

      const manager = new DebugSessionManager();
      managers.push(manager);

      const launched = await manager.launch({
        cwd: tmp,
        program: binPath,
        adapter: "synth",
        waitForStop: true,
      });

      assert.equal(launched.snapshot.state, "stopped");
      assert.equal(launched.snapshot.stopped?.threadId, 7);
      assert.equal(launched.snapshot.stack?.[0]?.instructionPointerReference, "0x100004000");

      const dis = await manager.disassemble({
        sessionId: launched.session.id,
        memoryReference: "0x100004000",
        instructionCount: 2,
      });
      assert.equal(dis.instructions.length, 2);
      assert.match(dis.instructions[0]?.instruction ?? "", /stp x29/);

      const mem = await manager.readMemory({
        sessionId: launched.session.id,
        memoryReference: "0x100004000",
        count: 8,
      });
      assert.equal(Buffer.from(mem.memory.dataBase64, "base64").toString("utf8"), "HelloDAP");

      const custom = await manager.customRequest({
        sessionId: launched.session.id,
        command: "customEcho",
        args: { ping: 123 },
      });
      assert.deepEqual(custom.body, { echoed: { ping: 123 } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces DAP output(stderr) crash diagnostics when a native adapter crashes mid-launch", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-dap-crash-"));
    try {
      const serverPath = writeSyntheticDapServer(tmp);
      const binPath = path.join(tmp, "crash.bin");
      fs.writeFileSync(binPath, "fake-binary", "utf8");

      fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".pi", "dap.json"),
        JSON.stringify({
          adapters: {
            crasher: {
              command: process.execPath,
              args: [serverPath, "crash"],
              transport: "stdio",
              fileExtensions: [".bin"],
            },
          },
        }),
        "utf8",
      );

      const manager = new DebugSessionManager();
      managers.push(manager);

      await assert.rejects(
        () =>
          manager.launch({
            cwd: tmp,
            program: binPath,
            adapter: "crasher",
          }),
        /ParseSymtab/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
