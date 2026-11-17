---
name: runtime-debugging
description: Debug Python, JavaScript/TypeScript, Go, Rust, C/C++, C#, and Ruby programs at runtime using `debug_probe` and `debugger`. Use when diagnosing wrong outputs, crashes, hangs, flaky tests, loop/state bugs, or inspecting live processes without adding print/console.log edits.
---

# Runtime Debugging (`pi-debugger`)

Use real runtime inspection instead of sprinkling temporary `print()` / `console.log()` edits across files.

## 1. Choose the Right Tool

| Goal | Tool | Why |
|------|------|-----|
| Inspect locals, watch expressions, loop iterations, or uncaught exceptions at known lines | `debug_probe` | Single tool call: launches, captures stack + locals + watches + source context + output, and cleans up all child processes automatically. |
| Step line-by-line (`step_over` / `step_in` / `step_out`), mutate expressions across pauses, debug two processes simultaneously (`s1`, `s2`), or attach to a running PID/port | `debugger` | Interactive multi-session DAP + V8 Inspector controller. |

## 2. Fast Root-Cause Workflow (`debug_probe`)

1. Locate the suspect function or assertion line with `read` / `grep`.
2. Call `debug_probe` with `program`, `line` (or `breakpoints: [...]`), and `watches` for the exact expressions you want verified:
   ```json
   {
     "program": "tests/repro.py",
     "line": 42,
     "watches": ["len(batch)", "cursor", "state.pending"],
     "max_hits": 3
   }
   ```
3. To diagnose an uncaught crash without knowing the exact line, omit `line` and set `break_on_exceptions: "uncaught"` — `debug_probe` pauses at the throw site and captures the live stack and local variables before unwinding.

## 3. Interactive & Multi-Session Workflow (`debugger`)

1. **Check available adapters (optional):**
   `debugger({ action: "doctor" })` reports discovered adapters (`node`, `debugpy`, `dlv`, `codelldb`, `lldb-dap`, `gdb`, `netcoredbg`, `rdbg`) and install hints.
2. **Launch with inline breakpoints (or stage breakpoints first):**
   ```json
   {
     "action": "launch",
     "program": "src/server.ts",
     "breakpoints": [{ "file": "src/server.ts", "line": 88, "condition": "req.retryCount > 1" }]
   }
   ```
3. **Inspect & step while paused:**
   - `debugger({ action: "evaluate", expression: "..." })`
   - `debugger({ action: "variables", max_depth: 2 })`
   - `debugger({ action: "step_over" })` / `step_in` / `step_out` / `continue`
4. **Attach to a live process or debug port:**
   - Port attach (`debugpy.listen`, `node --inspect`, `dlv dap --listen`):
     `debugger({ action: "attach", host: "127.0.0.1", port: 5678, adapter: "debugpy" })`
   - Live PID attach (Node.js signals `SIGUSR1` automatically; native uses LLDB/GDB):
     `debugger({ action: "attach", pid: 12345, adapter: "node" })`
5. **Concurrent client + server debugging:**
   Launch both targets — each receives its own session ID (`s1`, `s2`). Pass `session_id: "s1"` or `action: "switch"` to inspect both sides of an RPC/HTTP boundary.
6. **Always clean up interactive sessions:**
   Call `debugger({ action: "disconnect", all: true })` once root cause is confirmed.

## 4. Optional Project Configuration (`.pi/dap.json`)

Zero config works out of the box. When a project requires custom adapter paths or default launch flags, create `.pi/dap.json`:

```json
{
  "adapters": {
    "custom-lldb": {
      "transport": "stdio",
      "command": "/opt/llvm/bin/lldb-dap",
      "args": []
    }
  }
}
```
