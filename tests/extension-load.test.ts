import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import piDebuggerExtension from "../extensions/index.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Pi extension & skill package contract", () => {
  it("registers debug_probe, debugger, /dap command, and lifecycle hooks with zero startup side effects", () => {
    const tools = new Map<string, unknown>();
    const commands = new Map<string, unknown>();
    const events = new Map<string, unknown[]>();

    const fakePi = {
      on(event: string, handler: unknown) {
        const list = events.get(event) ?? [];
        list.push(handler);
        events.set(event, list);
        return () => undefined;
      },
      registerTool(def: { name: string; promptSnippet?: string; promptGuidelines?: string[] }) {
        tools.set(def.name, def);
      },
      registerCommand(name: string, opts: unknown) {
        commands.set(name, opts);
      },
    };

    // SAFETY: Minimal structural mock verifying extension factory registration contract
    piDebuggerExtension(fakePi as unknown as Parameters<typeof piDebuggerExtension>[0]);

    assert.ok(tools.has("debug_probe"));
    assert.ok(tools.has("debugger"));
    assert.ok(commands.has("dap"));
    assert.ok(events.has("session_start"));
    assert.ok(events.has("session_shutdown"));
  });

  it("loads cleanly via Pi's real DefaultResourceLoader (jiti extension + Agent Skill validation) and runs tool actions", async () => {
    const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dbg-agentdir-"));
    try {
      const loader = new DefaultResourceLoader({
        cwd: PKG_ROOT,
        agentDir: tmpAgentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [path.join(PKG_ROOT, "extensions", "index.ts")],
        additionalSkillPaths: [path.join(PKG_ROOT, "skills", "runtime-debugging")],
      });
      await loader.reload();

      const extRes = loader.getExtensions();
      assert.equal(extRes.errors.length, 0, `Extension load errors: ${JSON.stringify(extRes.errors)}`);

      const skillRes = loader.getSkills();
      assert.equal(skillRes.diagnostics.length, 0, `Skill diagnostics: ${JSON.stringify(skillRes.diagnostics)}`);
      assert.ok(
        skillRes.skills.some((s) => s.name === "runtime-debugging"),
        "Expected runtime-debugging skill to be discovered",
      );

      const loadedExt = extRes.extensions.find((e) => e.tools.has("debugger"));
      assert.ok(loadedExt, "Expected pi-debugger extension in loaded extensions");
      assert.ok(loadedExt.tools.has("debug_probe"));
      assert.ok(loadedExt.commands.has("dap"));

      const debuggerTool = loadedExt.tools.get("debugger");
      assert.ok(debuggerTool);

      // Execute action='doctor' through the real registered ToolDefinition
      // SAFETY: Minimal ExtensionContext stub for non-UI tool invocation
      const stubCtx = { cwd: PKG_ROOT, hasUI: false } as unknown as Parameters<typeof debuggerTool.definition.execute>[4];
      const doctorResult = await debuggerTool.definition.execute(
        "call-1",
        { action: "doctor" },
        undefined,
        undefined,
        stubCtx,
      );
      assert.equal(doctorResult.isError, undefined);
      const textBlock = doctorResult.content[0];
      assert.equal(textBlock?.type, "text");
      if (textBlock?.type === "text") {
        assert.match(textBlock.text, /\[READY\]\s+node.*V8 Inspector/i);
      }
    } finally {
      fs.rmSync(tmpAgentDir, { recursive: true, force: true });
    }
  });
});
