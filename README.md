# pi-debugger

Zero-config, multi-session **Debug Adapter Protocol (DAP) & V8 Inspector** package for the [Pi coding agent](https://pi.dev).

Inspect live variables, conditional breakpoints, call stacks, watch expressions, memory, and disassembly across **JavaScript/TypeScript, Python, Go, Rust, C/C++, Swift, Zig, .NET, and Ruby** — without writing temporary `print`/`console.log` statements or hand-editing adapter configs.

## Highlights

- **Zero-Config Adapter Discovery**:
  - **Node.js & TypeScript (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`)**: Built-in V8 Inspector backend over native `WebSocket` — **always available** with zero external downloads.
  - **Python (`.py`)**: Auto-detects project `.venv` / `conda` / `python3` + `debugpy`, or falls back to `uv run --no-project --with debugpy` so **any target Python interpreter can be debugged without installing `debugpy` into your project venv**.
  - **Go (`.go`)**: Auto-discovers Delve (`dlv dap --listen=127.0.0.1:0`).
  - **Rust / C / C++ / Zig / Swift**: Auto-discovers `codelldb` (PATH or VS Code / Cursor / Windsurf extensions), `lldb-dap` (PATH, Homebrew LLVM, or macOS `xcrun`), and `gdb >= 14` (`gdb -i dap`). Automatically filters SIMD/register scope noise out of stop snapshots while keeping `Registers` available on demand.
  - **.NET & Ruby**: Auto-discovers `netcoredbg` and `rdbg`.
- **One-Shot `debug_probe` Tool**: Launch a script/test/binary, capture locals + stack + watch expressions across up to `maxHits` conditional breakpoint hits (or uncaught exceptions), and clean up automatically in **one tool call**.
- **Live `attach` Mode**: Non-destructively attach to running Node processes by **PID** (signals V8 via `process._debugProcess(pid)`) or `--inspect` port, `debugpy.listen((host, port))` TCP servers, Delve, or native PIDs — and detach without killing the target service.
- **Multi-Session Debugging**: Debug a client and server (e.g., Python backend `s1` + Node worker `s2`) concurrently in the same Pi turn.
- **Zero Runtime Dependencies**: Pure Node.js built-ins + Pi host peer APIs.

---

## Installation

```bash
# From npm (once published)
pi install npm:pi-debugger

# Or directly from GitHub
pi install git:github.com/yiyabo/pi-debugger
```

Check detected language adapters inside Pi at any time with:

```text
/dap doctor
```

---

## Provided Tools & Commands

### 1. `debug_probe` — One-Shot Runtime Inspection

Best when you want to verify runtime state at specific lines or catch an exception without managing session lifecycle:

```json
{
  "program": "src/pricing.py",
  "args": ["--region", "eu"],
  "breakpoints": [
    { "line": 42, "condition": "discount < 0" }
  ],
  "expressions": ["cart.subtotal", "discount", "tax_rate"],
  "maxHits": 3
}
```

### 2. `debugger` — Interactive Multi-Session Controller

Full stateful control across 24 actions:

| Category | Actions |
| --- | --- |
| Diagnostics | `doctor`, `sessions`, `switch_session`, `output`, `threads` |
| Lifecycle | `launch`, `attach`, `disconnect`, `restart` |
| Breakpoints | `set_breakpoints` (works **before** or **after** `launch`/`attach`), `clear_breakpoints`, `list_breakpoints`, `set_exception_breakpoints` |
| Execution | `continue`, `pause`, `step_over`, `step_into`, `step_out` |
| Inspection | `stack_trace`, `variables` (`scopeFilter`, `variablesReference`), `evaluate` |
| Low-level / Escape Hatch | `disassemble`, `read_memory`, `custom_request` |

### 3. `/dap` Slash Command & TUI Status

- `/dap` or `/dap sessions` — Show active debug sessions and states
- `/dap doctor` — Show adapter discovery report for the current workspace
- `/dap stop [sessionId]` — Disconnect one or all active debug sessions
- Footer status badge automatically displays active session state (`🐞 s1:stopped@app.py:42`).

### 4. `runtime-debugging` Agent Skill

Bundled skill teaching the agent hypothesis-driven debugging workflows (conditional breakpoints, binary-search narrowing, multi-session client/server tracing, and non-destructive live attach).

---

## Optional Custom Adapter Configuration

Zero configuration is needed for standard toolchains. To add a custom DAP adapter or override defaults, create `.pi/dap.json` (project) or `~/.pi/agent/dap.json` (global), or nest under `"dap": { "adapters": { ... } }` in `settings.json`:

```json
{
  "adapters": {
    "custom-rust": {
      "command": "/opt/codelldb/adapter/codelldb",
      "args": ["--port", "0"],
      "transport": "tcp-spawn",
      "languages": ["rust"],
      "fileExtensions": [".rs"]
    }
  }
}
```

Supported `transport` modes:
- `"stdio"` — Standard DAP `Content-Length` framing over stdin/stdout
- `"tcp-spawn"` — Spawns adapter, parses listening port from stdout/stderr, connects via TCP
- `"tcp-connect"` — Connects directly to an already-listening DAP TCP socket (`host` + `port`)
- `"node-inspector"` — Built-in V8 Inspector backend

---

## Development & Testing

```bash
npm install
npm run check
```

## License

MIT
