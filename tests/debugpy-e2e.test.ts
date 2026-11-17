import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAllAdapters, runAdapterDoctor } from "../src/adapters/discovery.ts";
import { DebugSessionManager } from "../src/session-manager.ts";

describe("Python debugpy & multi-session live e2e", () => {
  const doctor = runAdapterDoctor(process.cwd());
  const debugpyReady = doctor.find((d) => d.name === "debugpy")?.available ?? false;
  const pyAdapter = discoverAllAdapters(process.cwd()).get("debugpy");
  const managers: DebugSessionManager[] = [];

  afterEach(async () => {
    while (managers.length > 0) {
      const m = managers.pop();
      if (m) {
        await m.disposeAll();
      }
    }
  });

  it("debug_probe inspects Python variables and conditional breakpoints via debugpy", { skip: !debugpyReady }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-py-probe-"));
    try {
      const script = path.join(tmp, "worker.py");
      fs.writeFileSync(
        script,
        [
          "def compute(values):",
          "    acc = 0",
          "    for idx, val in enumerate(values):",
          "        acc += val * 2",
          "    return acc",
          "",
          "result = compute([2, 5, 9])",
          "print('RESULT', result)",
        ].join("\n"),
        "utf8",
      );

      const manager = new DebugSessionManager();
      managers.push(manager);

      const probe = await manager.runProbe({
        cwd: tmp,
        program: script,
        breakpoints: [{ file: script, line: 4, condition: "idx == 2" }],
        expressions: ["acc", "val", "acc + val * 2"],
        maxHits: 1,
        timeoutMs: 25_000,
      });

      assert.equal(probe.adapter, "debugpy");
      assert.equal(probe.timedOut, false);
      assert.equal(probe.hits.length, 1);
      assert.equal(probe.hits[0]?.line, 4);
      assert.equal(probe.hits[0]?.evaluations.find((e) => e.expression === "acc")?.result, "14");
      assert.equal(probe.hits[0]?.evaluations.find((e) => e.expression === "acc + val * 2")?.result, "32");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("attaches directly to debugpy.listen TCP port AND runs concurrent Python + Node sessions", { skip: !debugpyReady }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-multi-"));
    const pyServer = path.join(tmp, "remote_target.py");
    const jsClient = path.join(tmp, "client.js");

    fs.writeFileSync(
      pyServer,
      [
        "import debugpy, sys",
        "host, port = debugpy.listen(('127.0.0.1', 0))",
        "print(f'PORT={port}', flush=True)",
        "debugpy.wait_for_client()",
        "secret_code = 4242",
        "doubled = secret_code * 2",
        "print('DONE', doubled, flush=True)",
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      jsClient,
      [
        "const token = 'alpha-9';",
        "const payload = { token, retries: 2 };",
        "console.log(payload.token);",
      ].join("\n"),
      "utf8",
    );

    assert.ok(pyAdapter, "expected debugpy adapter when debugpyReady=true");
    const spawnCmd = pyAdapter.command ?? "python3";
    const spawnArgs =
      path.basename(spawnCmd) === "uv"
        ? ["run", "--no-project", "--with", "debugpy", "python3", pyServer]
        : [pyServer];
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for debugpy PORT")), 15_000);
        let buf = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const m = /PORT=(\d+)/.exec(buf);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
      });

      const manager = new DebugSessionManager();
      managers.push(manager);

      const pyAttached = await manager.attach({
        cwd: tmp,
        host: "127.0.0.1",
        port,
        adapter: "debugpy",
        breakpoints: [{ file: pyServer, line: 6 }],
        waitForStop: true,
        waitTimeoutMs: 15_000,
      });

      const jsLaunched = await manager.launch({
        cwd: tmp,
        program: jsClient,
        breakpoints: [{ file: jsClient, line: 3 }],
        waitForStop: true,
        waitTimeoutMs: 15_000,
      });

      assert.equal(manager.listSessions().length, 2);
      assert.equal(pyAttached.snapshot.state, "stopped");
      assert.equal(jsLaunched.snapshot.state, "stopped");

      const pyEval = await manager.evaluate({ sessionId: pyAttached.session.id, expression: "secret_code" });
      const jsEval = await manager.evaluate({ sessionId: jsLaunched.session.id, expression: "payload.token" });

      assert.equal(pyEval.evaluation.result, "4242");
      assert.match(jsEval.evaluation.result, /alpha-9/);

      await manager.disconnect({ all: true });
      assert.equal(manager.listSessions().length, 0);
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
