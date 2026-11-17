import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runAdapterDoctor, selectAdapterForLaunch } from "../src/adapters/discovery.ts";
import { DapFrameParser, encodeDapMessage } from "../src/dap/framing.ts";
import type { DapWireMessage } from "../src/types.ts";
import { whichExecutable } from "../src/utils/process-tree.ts";
import { formatDisplayPath, readSourceSnippet, resolveToolPath } from "../src/utils/source-context.ts";

describe("DAP Content-Length framing", () => {
  it("round-trips multi-byte UTF-8 payloads across byte-by-byte chunks", () => {
    const received: DapWireMessage[] = [];
    const errors: Error[] = [];
    const parser = new DapFrameParser({
      onMessage: (msg) => received.push(msg),
      onProtocolError: (err) => errors.push(err),
    });

    const payload1: DapWireMessage = {
      seq: 1,
      type: "request",
      command: "evaluate",
      arguments: { expression: "你好 🐞 π" },
    };
    const payload2: DapWireMessage = {
      seq: 2,
      type: "response",
      request_seq: 1,
      command: "evaluate",
      success: true,
      body: { result: "'你好 🐞 π'" },
    };
    const combined = Buffer.concat([encodeDapMessage(payload1), encodeDapMessage(payload2)]);

    for (let i = 0; i < combined.length; i += 3) {
      parser.push(combined.subarray(i, i + 3));
    }

    assert.equal(errors.length, 0);
    assert.deepEqual(received, [payload1, payload2]);
  });

  it("recovers when an adapter emits stray banner text before Content-Length", () => {
    const received: DapWireMessage[] = [];
    const stray: string[] = [];
    const parser = new DapFrameParser({
      onMessage: (msg) => received.push(msg),
      onStrayOutput: (prefix) => stray.push(prefix),
    });

    const banner = Buffer.from("Debugger listening banner\n", "utf8");
    const msg: DapWireMessage = { seq: 1, type: "event", event: "initialized" };
    parser.push(Buffer.concat([banner, encodeDapMessage(msg)]));

    assert.equal(stray.length, 1);
    assert.match(stray[0] ?? "", /Debugger listening banner/);
    assert.deepEqual(received, [msg]);
  });
});

describe("Path & executable utilities", () => {
  it("whichExecutable ignores directories on PATH that share an executable name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-which-"));
    try {
      const dirCollision = path.join(tmp, "fakebin");
      fs.mkdirSync(dirCollision);
      const found = whichExecutable("fakebin", [tmp]);
      assert.equal(found, null);

      const realBin = path.join(tmp, "realtool");
      fs.writeFileSync(realBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      assert.equal(whichExecutable("realtool", [tmp]), realBin);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolveToolPath strips leading @ and resolves against workspace cwd", () => {
    assert.equal(resolveToolPath("@src/index.ts", "/workspace/app"), "/workspace/app/src/index.ts");
    assert.equal(formatDisplayPath("/workspace/app/src/index.ts", "/workspace/app"), "src/index.ts");
  });

  it("readSourceSnippet highlights target line and clamps boundaries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-src-"));
    try {
      const file = path.join(tmp, "sample.py");
      fs.writeFileSync(file, "a = 1\nb = 2\nc = a + b\nd = c * 2\n", "utf8");
      const snippet = readSourceSnippet(file, 3, 1);
      assert.ok(snippet);
      assert.equal(snippet.startLine, 2);
      assert.equal(snippet.endLine, 4);
      const current = snippet.lines.find((l) => l.isCurrent);
      assert.equal(current?.line, 3);
      assert.equal(current?.text, "c = a + b");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Zero-config adapter discovery", () => {
  it("discovers built-in Node V8 Inspector for .js and .ts files", () => {
    const jsRes = selectAdapterForLaunch({ cwd: process.cwd(), program: "script.js" });
    assert.equal(jsRes.adapter.name, "node");
    assert.equal(jsRes.adapter.transport, "node-inspector");

    const tsRes = selectAdapterForLaunch({ cwd: process.cwd(), program: "script.ts" });
    assert.equal(tsRes.adapter.name, "node");

    const doctor = runAdapterDoctor(process.cwd());
    const nodeEntry = doctor.find((d) => d.name === "node");
    assert.equal(nodeEntry?.available, true);
  });
});
