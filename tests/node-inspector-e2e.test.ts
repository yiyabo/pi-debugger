import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { DebugSessionManager } from "../src/session-manager.ts";

describe("Node/TypeScript V8 Inspector live e2e", () => {
  const managers: DebugSessionManager[] = [];

  afterEach(async () => {
    while (managers.length > 0) {
      const m = managers.pop();
      if (m) {
        await m.disposeAll();
      }
    }
  });

  it("debug_probe captures multi-hit loop locals and watch expressions in TypeScript", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-node-probe-"));
    try {
      const script = path.join(tmp, "calc.ts");
      fs.writeFileSync(
        script,
        [
          "interface Item { label: string; weight: number }",
          "const items: Item[] = [{ label: 'a', weight: 3 }, { label: 'b', weight: 7 }, { label: 'c', weight: 11 }];",
          "let runningTotal = 0;",
          "for (const item of items) {",
          "  runningTotal += item.weight;",
          "  console.log('step', item.label, runningTotal);",
          "}",
          "console.log('final', runningTotal);",
        ].join("\n"),
        "utf8",
      );

      const manager = new DebugSessionManager();
      managers.push(manager);

      const probe = await manager.runProbe({
        cwd: tmp,
        program: script,
        breakpoints: [{ file: script, line: 6 }],
        expressions: ["runningTotal", "item.label"],
        maxHits: 2,
        timeoutMs: 15_000,
      });

      assert.equal(probe.adapter, "node");
      assert.equal(probe.timedOut, false);
      assert.equal(probe.hits.length, 2);
      assert.equal(probe.hits[0]?.evaluations.find((e) => e.expression === "runningTotal")?.result, "3");
      assert.equal(probe.hits[1]?.evaluations.find((e) => e.expression === "runningTotal")?.result, "10");
      assert.equal(manager.listSessions().length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("supports staged breakpoints, live PID attach, evaluate, and non-destructive detach", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-node-live-"));
    const bgScript = path.join(tmp, "daemon.js");
    fs.writeFileSync(
      bgScript,
      [
        "let tick = 0;",
        "function heartbeat() {",
        "  tick += 1;",
        "  return tick * 10;",
        "}",
        "setInterval(heartbeat, 80);",
        "process.stdout.write('READY\\n');",
      ].join("\n"),
      "utf8",
    );

    const daemon = spawn(process.execPath, [bgScript], {
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("daemon READY timeout")), 5_000);
        daemon.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      const daemonPid = daemon.pid;
      assert.ok(daemonPid, "daemon pid must exist");
      const manager = new DebugSessionManager();
      managers.push(manager);

      await manager.setBreakpoints({
        cwd: tmp,
        file: bgScript,
        lines: [4],
      });

      const attached = await manager.attach({
        cwd: tmp,
        pid: daemonPid,
        adapter: "node",
        waitForStop: true,
        waitTimeoutMs: 10_000,
      });

      assert.equal(attached.snapshot.state, "stopped");
      assert.equal(attached.snapshot.location?.line, 4);

      const ev = await manager.evaluate({
        sessionId: attached.session.id,
        expression: "tick > 0",
      });
      assert.equal(ev.evaluation.result, "true");

      await manager.disconnect({ sessionId: attached.session.id, terminateDebuggee: false });
      assert.doesNotThrow(() => process.kill(daemonPid, 0), "detached daemon should stay alive");
    } finally {
      daemon.kill("SIGKILL");
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
