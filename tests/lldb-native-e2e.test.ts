import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverAllAdapters } from "../src/adapters/discovery.ts";
import { DebugSessionManager } from "../src/session-manager.ts";
import { whichExecutable } from "../src/utils/process-tree.ts";

describe("Native compiled C + lldb-dap live e2e", () => {
  it("auto-selects lldb-dap on a compiled C binary, filters register noise, and disassembles instructions", async (t) => {
    const clang = whichExecutable("clang") ?? whichExecutable("gcc");
    const lldb = discoverAllAdapters(process.cwd()).get("lldb-dap");
    if (!clang || !lldb) {
      t.skip("clang or lldb-dap not installed on this host");
      return;
    }
    if (lldb.resolvedBinary === "/Library/Developer/CommandLineTools/usr/bin/lldb-dap") {
      t.skip("macOS CommandLineTools lldb-dap has a known Apple beta ParseSymtab crash; Homebrew llvm lldb-dap required");
      return;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-lldb-"));
    const srcFile = path.join(tmp, "native_calc.c");
    const binFile = path.join(tmp, "native_calc");
    fs.writeFileSync(
      srcFile,
      [
        "int main(void) {",
        "  int acc = 10;",
        "  for (int i = 1; i <= 3; i++) {",
        "    acc += i * 5;",
        "  }",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    );
    execFileSync(clang, ["-g", "-O0", srcFile, "-o", binFile]);

    const manager = new DebugSessionManager();
    try {
      // 1. One-shot probe on extensionless native binary (zero-config adapter selection!)
      const probe = await manager.runProbe({
        cwd: tmp,
        program: binFile,
        breakpoints: [{ file: srcFile, line: 4, condition: "i == 2" }],
        expressions: ["acc", "i", "acc + i * 5"],
        timeoutMs: 20_000,
      });

      assert.equal(probe.adapter, "lldb-dap");
      assert.equal(probe.timedOut, false);
      assert.equal(probe.hits.length, 1);
      const hit = probe.hits[0];
      assert.ok(hit.locals.some((v) => v.name === "acc" && v.value === "15"));
      assert.ok(hit.locals.some((v) => v.name === "i" && v.value === "2"));
      // Verify SIMD/CPU registers were NOT dumped into automatic stop locals
      assert.equal(hit.locals.some((v) => v.name === "General Purpose Registers" || v.name === "v0"), false);
      assert.equal(hit.evaluations.find((w) => w.expression === "acc + i * 5")?.result, "25");

      // 2. Interactive session: disassemble machine instructions + explicit Registers scopeFilter
      const launched = await manager.launch({
        cwd: tmp,
        program: binFile,
        breakpoints: [{ file: srcFile, line: 4 }],
      });
      assert.equal(launched.snapshot.state, "stopped");
      const topPc = launched.snapshot.stack?.[0]?.instructionPointerReference;
      assert.ok(topPc, "expected instructionPointerReference on native frame");

      const disasm = await manager.disassemble({
        sessionId: launched.session.id,
        memoryReference: topPc,
        instructionCount: 4,
      });
      assert.equal(disasm.instructions.length, 4);
      assert.ok(disasm.instructions[0]?.instruction.length > 0);

      // Explicit scopeFilter="Registers" still grants on-demand CPU register access
      const regs = await manager.variables({
        sessionId: launched.session.id,
        scopeFilter: "Registers",
        maxDepth: 1,
      });
      assert.equal(regs.scopes.length, 1);
      assert.match(regs.scopes[0]?.scope.name ?? "", /Registers/i);
    } finally {
      await manager.disposeAll();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
