/**
 * Zero-config multi-language debug adapter discovery + custom config overrides.
 *
 * Out-of-the-box languages:
 *  - JavaScript / TypeScript (.js, .mjs, .cjs, .ts, .mts, .cts, .jsx, .tsx): built-in V8 Inspector (always available!)
 *  - Python (.py): auto-detects project .venv / conda / python3 + debugpy OR uv --with debugpy (zero-install in target env!)
 *  - Go (.go): dlv dap --listen=127.0.0.1:0 (tcp-spawn)
 *  - Rust / C / C++ / Zig / Swift: codelldb (PATH + VS Code / Cursor extensions), lldb-dap (PATH + Homebrew + macOS xcrun), gdb >= 14 (-i dap)
 *  - .NET (.dll, .cs): netcoredbg --interpreter=vscode
 *  - Ruby (.rb): rdbg
 *
 * Overrides supported in:
 *  - <cwd>/.pi/dap.json or <cwd>/.pi/settings.json ("dap.adapters")
 *  - ~/.pi/agent/dap.json or ~/.pi/agent/settings.json ("dap.adapters")
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { AdapterDoctorEntry, DebugTransportKind, ResolvedAdapter } from "../types.ts";
import { isExecutableFile, whichExecutable } from "../utils/process-tree.ts";

interface CustomAdapterConfig {
  command?: string;
  args?: string[];
  transport?: DebugTransportKind;
  host?: string;
  port?: number;
  languages?: string[];
  fileExtensions?: string[];
  launchDefaults?: Record<string, unknown>;
  attachDefaults?: Record<string, unknown>;
}

const debugpyProbeCache = new Map<string, boolean>();
let cachedXcrunLldbDap: string | null | undefined;
const gdbDapSupportCache = new Map<string, boolean>();

function pythonHasDebugpy(pythonBin: string): boolean {
  const cached = debugpyProbeCache.get(pythonBin);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const res = spawnSync(pythonBin, ["-c", "import debugpy"], {
      stdio: "ignore",
      timeout: 2500,
    });
    const ok = res.status === 0;
    debugpyProbeCache.set(pythonBin, ok);
    return ok;
  } catch {
    debugpyProbeCache.set(pythonBin, false);
    return false;
  }
}

export function detectProjectPython(cwd: string, explicitPython?: string): string | null {
  if (explicitPython) {
    const resolved = whichExecutable(explicitPython, [cwd]);
    if (resolved) {
      return resolved;
    }
  }

  const binSubdir = process.platform === "win32" ? "Scripts" : "bin";
  const pyName = process.platform === "win32" ? "python.exe" : "python";
  const candidates = [
    process.env.VIRTUAL_ENV ? path.join(process.env.VIRTUAL_ENV, binSubdir, pyName) : "",
    path.join(cwd, ".venv", binSubdir, pyName),
    path.join(cwd, "venv", binSubdir, pyName),
    path.join(cwd, ".env", binSubdir, pyName),
    process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, binSubdir, pyName) : "",
  ].filter(Boolean);

  for (const c of candidates) {
    if (isExecutableFile(c)) {
      return c;
    }
  }

  return whichExecutable("python3") ?? whichExecutable("python");
}

function resolveDebugpyAdapter(cwd: string, explicitPython?: string): ResolvedAdapter | null {
  const debuggeePython = detectProjectPython(cwd, explicitPython) ?? undefined;

  // 1. Check if debuggeePython itself has debugpy installed
  if (debuggeePython && pythonHasDebugpy(debuggeePython)) {
    return {
      name: "debugpy",
      displayName: "Python (debugpy)",
      transport: "stdio",
      languages: ["python"],
      fileExtensions: [".py", ".pyw"],
      command: debuggeePython,
      args: ["-m", "debugpy.adapter"],
      resolvedBinary: debuggeePython,
      debuggeePython,
      launchDefaults: { console: "internalConsole", justMyCode: true },
      attachDefaults: { justMyCode: true },
      notes: `Using debugpy in ${debuggeePython}`,
      source: "auto-discovered",
    };
  }

  // 2. Check other local Python binaries that already have debugpy installed
  const otherPythons = [
    whichExecutable("python3"),
    whichExecutable("python"),
    path.join(os.homedir(), "miniconda3", "bin", "python"),
    path.join(os.homedir(), "anaconda3", "bin", "python"),
  ].filter((p): p is string => Boolean(p && isExecutableFile(p)));

  for (const py of otherPythons) {
    if (pythonHasDebugpy(py)) {
      return {
        name: "debugpy",
        displayName: "Python (debugpy)",
        transport: "stdio",
        languages: ["python"],
        fileExtensions: [".py", ".pyw"],
        command: py,
        args: ["-m", "debugpy.adapter"],
        resolvedBinary: py,
        debuggeePython: debuggeePython ?? py,
        launchDefaults: { console: "internalConsole", justMyCode: true },
        attachDefaults: { justMyCode: true },
        notes: `Adapter via ${py}; target python ${debuggeePython ?? py}`,
        source: "auto-discovered",
      };
    }
  }

  // 3. Zero-config uv fallback: runs debugpy.adapter from uv's ephemeral cache
  //    while launching the user's unmodified debuggeePython!
  const uvBin = whichExecutable("uv", [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
  ]);
  if (uvBin && debuggeePython) {
    return {
      name: "debugpy",
      displayName: "Python (debugpy via uv)",
      transport: "stdio",
      languages: ["python"],
      fileExtensions: [".py", ".pyw"],
      command: uvBin,
      args: ["run", "--no-project", "--with", "debugpy", "python3", "-m", "debugpy.adapter"],
      resolvedBinary: uvBin,
      debuggeePython,
      launchDefaults: { console: "internalConsole", justMyCode: true },
      attachDefaults: { justMyCode: true },
      notes: `Zero-install adapter via uv; target python ${debuggeePython}`,
      source: "auto-discovered",
    };
  }

  return null;
}

function findCodeLldbBinary(): string | null {
  const onPath = whichExecutable("codelldb");
  if (onPath) {
    return onPath;
  }
  const home = os.homedir();
  const extRoots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".windsurf", "extensions"),
  ];
  const exeName = process.platform === "win32" ? "codelldb.exe" : "codelldb";
  for (const root of extRoots) {
    try {
      const entries = fs.readdirSync(root)
        .filter((e) => e.startsWith("vadimcn.vscode-lldb-"))
        .sort((a, b) => b.localeCompare(a));
      for (const dir of entries) {
        const candidate = path.join(root, dir, "adapter", exeName);
        if (isExecutableFile(candidate)) {
          return candidate;
        }
      }
    } catch {
      // ignore missing IDE extension dirs
    }
  }
  return null;
}

function findLldbDapBinary(): string | null {
  const extraDirs = [
    "/opt/homebrew/opt/llvm/bin",
    "/usr/local/opt/llvm/bin",
    "/Library/Developer/CommandLineTools/usr/bin",
  ];
  const direct = whichExecutable("lldb-dap", extraDirs) ?? whichExecutable("lldb-vscode", extraDirs);
  if (direct) {
    return direct;
  }
  if (process.platform === "darwin") {
    if (cachedXcrunLldbDap !== undefined) {
      return cachedXcrunLldbDap;
    }
    try {
      const res = spawnSync("xcrun", ["--find", "lldb-dap"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      const candidate = res.stdout?.trim() ?? "";
      cachedXcrunLldbDap = res.status === 0 && isExecutableFile(candidate) ? candidate : null;
      return cachedXcrunLldbDap;
    } catch {
      cachedXcrunLldbDap = null;
    }
  }
  return null;
}

function findGdbDapBinary(): string | null {
  const gdb = whichExecutable("gdb");
  if (!gdb) {
    return null;
  }
  const cached = gdbDapSupportCache.get(gdb);
  if (cached !== undefined) {
    return cached ? gdb : null;
  }
  try {
    const res = spawnSync(gdb, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const firstLine = (res.stdout ?? "").split(/\r?\n/)[0] ?? "";
    const match = firstLine.match(/(\d+)\.(\d+)/);
    const major = match ? Number.parseInt(match[1], 10) : 0;
    const supported = major >= 14;
    gdbDapSupportCache.set(gdb, supported);
    return supported ? gdb : null;
  } catch {
    gdbDapSupportCache.set(gdb, false);
    return null;
  }
}

function loadCustomAdapters(cwd: string): Map<string, ResolvedAdapter> {
  const home = os.homedir();
  const sources: Array<{ file: string; scope: "user-config" | "project-config"; nestedUnderDap: boolean }> = [
    { file: path.join(home, ".pi", "agent", "settings.json"), scope: "user-config", nestedUnderDap: true },
    { file: path.join(home, ".pi", "agent", "dap.json"), scope: "user-config", nestedUnderDap: false },
    { file: path.join(cwd, ".pi", "settings.json"), scope: "project-config", nestedUnderDap: true },
    { file: path.join(cwd, ".pi", "dap.json"), scope: "project-config", nestedUnderDap: false },
  ];

  const out = new Map<string, ResolvedAdapter>();
  for (const src of sources) {
    try {
      if (!fs.existsSync(src.file)) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(src.file, "utf8")) as Record<string, unknown>;
      const rawRoot = src.nestedUnderDap ? (parsed.dap as Record<string, unknown> | undefined) : parsed;
      const adaptersObj = (rawRoot?.adapters ?? (!src.nestedUnderDap ? rawRoot : undefined)) as Record<string, CustomAdapterConfig> | undefined;
      if (!adaptersObj || typeof adaptersObj !== "object") {
        continue;
      }
      for (const [name, cfg] of Object.entries(adaptersObj)) {
        if (!cfg || typeof cfg !== "object") {
          continue;
        }
        const transport: DebugTransportKind = cfg.transport
          ?? (cfg.port ? "tcp-connect" : "stdio");
        const resolvedBin = cfg.command ? (whichExecutable(cfg.command, [cwd]) ?? cfg.command) : undefined;
        out.set(name, {
          name,
          displayName: `${name} (${src.scope})`,
          transport,
          languages: cfg.languages ?? [],
          fileExtensions: (cfg.fileExtensions ?? []).map((e) => e.toLowerCase()),
          command: cfg.command,
          args: cfg.args ?? [],
          resolvedBinary: resolvedBin,
          host: cfg.host,
          port: cfg.port,
          launchDefaults: cfg.launchDefaults,
          attachDefaults: cfg.attachDefaults,
          source: src.scope,
        });
      }
    } catch {
      // ignore malformed user JSON
    }
  }
  return out;
}

export function discoverAllAdapters(cwd: string, explicitPython?: string): Map<string, ResolvedAdapter> {
  const map = new Map<string, ResolvedAdapter>();

  // 1. Always-available built-in Node.js / TypeScript V8 Inspector
  map.set("node", {
    name: "node",
    displayName: "Node.js / TypeScript (Built-in V8 Inspector)",
    transport: "node-inspector",
    languages: ["javascript", "typescript"],
    fileExtensions: [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"],
    resolvedBinary: process.execPath,
    notes: `Built-in V8 Inspector via ${process.execPath} (${process.version})`,
    source: "builtin",
  });

  // 2. Python debugpy (venv / conda / global / zero-install uv)
  const debugpy = resolveDebugpyAdapter(cwd, explicitPython);
  if (debugpy) {
    map.set("debugpy", debugpy);
  }

  // 3. Go Delve (dlv dap --listen=127.0.0.1:0)
  const goPath = process.env.GOPATH ?? path.join(os.homedir(), "go");
  const dlvBin = whichExecutable("dlv", [path.join(goPath, "bin")]);
  if (dlvBin) {
    map.set("dlv", {
      name: "dlv",
      displayName: "Go (Delve DAP)",
      transport: "tcp-spawn",
      languages: ["go"],
      fileExtensions: [".go"],
      command: dlvBin,
      args: ["dap", "--listen=127.0.0.1:0"],
      resolvedBinary: dlvBin,
      launchDefaults: { mode: "debug" },
      attachDefaults: { mode: "local" },
      notes: `Delve TCP DAP at ${dlvBin}`,
      source: "auto-discovered",
    });
  }

  // 4. CodeLLDB (Rust / C / C++ / Zig)
  const codeLldb = findCodeLldbBinary();
  if (codeLldb) {
    map.set("codelldb", {
      name: "codelldb",
      displayName: "Native C/C++/Rust/Zig (CodeLLDB)",
      transport: "tcp-spawn",
      languages: ["rust", "c", "cpp", "zig"],
      fileExtensions: [".rs", ".c", ".cc", ".cpp", ".cxx", ".zig"],
      command: codeLldb,
      args: ["--port", "0"],
      resolvedBinary: codeLldb,
      notes: `CodeLLDB TCP DAP at ${codeLldb}`,
      source: "auto-discovered",
    });
  }

  // 5. lldb-dap (LLVM / Xcode / CommandLineTools)
  const lldbDap = findLldbDapBinary();
  if (lldbDap) {
    map.set("lldb-dap", {
      name: "lldb-dap",
      displayName: "Native C/C++/Rust/Swift (lldb-dap)",
      transport: "stdio",
      languages: ["c", "cpp", "rust", "swift", "zig", "objective-c"],
      fileExtensions: [".c", ".cc", ".cpp", ".cxx", ".rs", ".swift", ".zig", ".m", ".mm"],
      command: lldbDap,
      args: [],
      resolvedBinary: lldbDap,
      notes: `LLDB DAP at ${lldbDap}`,
      source: "auto-discovered",
    });
  }

  // 6. GDB >= 14 (-i dap)
  const gdbBin = findGdbDapBinary();
  if (gdbBin) {
    map.set("gdb", {
      name: "gdb",
      displayName: "Native C/C++/Rust (GDB DAP)",
      transport: "stdio",
      languages: ["c", "cpp", "rust", "fortran"],
      fileExtensions: [".c", ".cc", ".cpp", ".cxx", ".rs", ".f90"],
      command: gdbBin,
      args: ["-i", "dap"],
      resolvedBinary: gdbBin,
      notes: `GDB >= 14 native DAP at ${gdbBin}`,
      source: "auto-discovered",
    });
  }

  // 7. .NET netcoredbg
  const netcoredbg = whichExecutable("netcoredbg");
  if (netcoredbg) {
    map.set("netcoredbg", {
      name: "netcoredbg",
      displayName: ".NET (netcoredbg)",
      transport: "stdio",
      languages: ["csharp", "fsharp"],
      fileExtensions: [".dll", ".cs", ".fs"],
      command: netcoredbg,
      args: ["--interpreter=vscode"],
      resolvedBinary: netcoredbg,
      source: "auto-discovered",
    });
  }

  // 8. Ruby rdbg
  const rdbg = whichExecutable("rdbg");
  if (rdbg) {
    map.set("rdbg", {
      name: "rdbg",
      displayName: "Ruby (debug / rdbg)",
      transport: "tcp-spawn",
      languages: ["ruby"],
      fileExtensions: [".rb"],
      command: rdbg,
      args: ["--open", "--port", "0"],
      resolvedBinary: rdbg,
      source: "auto-discovered",
    });
  }

  // 9. User / project custom overrides win last
  for (const [name, custom] of loadCustomAdapters(cwd).entries()) {
    map.set(name, custom);
  }

  return map;
}

const ADAPTER_ALIASES: Record<string, string> = {
  python: "debugpy",
  py: "debugpy",
  javascript: "node",
  js: "node",
  typescript: "node",
  ts: "node",
  "node-inspector": "node",
  go: "dlv",
  delve: "dlv",
  lldb: "lldb-dap",
  rust: "codelldb",
};

export function selectAdapterForLaunch(opts: {
  program: string;
  cwd: string;
  adapter?: string;
  pythonPath?: string;
}): { adapter: ResolvedAdapter; launchOverrides: Record<string, unknown> } {
  const discovered = discoverAllAdapters(opts.cwd, opts.pythonPath);

  if (opts.adapter) {
    const canonical = ADAPTER_ALIASES[opts.adapter.toLowerCase()] ?? opts.adapter;
    // Allow rust -> lldb-dap fallback if codelldb isn't installed
    const picked = discovered.get(canonical)
      ?? (canonical === "codelldb" ? (discovered.get("lldb-dap") ?? discovered.get("gdb")) : undefined);
    if (!picked) {
      const available = [...discovered.keys()].join(", ") || "none";
      throw new Error(`Debug adapter '${opts.adapter}' is not available. Detected adapters: ${available}`);
    }
    return {
      adapter: picked,
      launchOverrides: inferLaunchOverrides(picked, opts.program),
    };
  }

  const ext = path.extname(opts.program).toLowerCase();
  let isDir = false;
  try {
    isDir = fs.statSync(opts.program).isDirectory();
  } catch {
    // ignore
  }

  if (isDir) {
    if (fs.existsSync(path.join(opts.program, "go.mod")) && discovered.has("dlv")) {
      const dlv = discovered.get("dlv")!;
      return { adapter: dlv, launchOverrides: { mode: "debug" } };
    }
  }

  if (ext) {
    for (const candidate of discovered.values()) {
      if (candidate.fileExtensions.includes(ext)) {
        return {
          adapter: candidate,
          launchOverrides: inferLaunchOverrides(candidate, opts.program),
        };
      }
    }
  }

  // Extensionless executable binary (compiled Rust / C / C++ / Go)
  if (!ext) {
    if (fs.existsSync(path.join(opts.cwd, "go.mod")) && discovered.has("dlv")) {
      return { adapter: discovered.get("dlv")!, launchOverrides: { mode: "exec" } };
    }
    for (const nativeName of ["codelldb", "lldb-dap", "gdb", "dlv"]) {
      const found = discovered.get(nativeName);
      if (found) {
        return { adapter: found, launchOverrides: inferLaunchOverrides(found, opts.program) };
      }
    }
  }

  const available = [...discovered.keys()].join(", ") || "none";
  throw new Error(
    `Could not auto-select a debug adapter for '${path.basename(opts.program)}'. Detected adapters: ${available}. Pass 'adapter' explicitly or add .pi/dap.json.`,
  );
}

export function selectAdapterForAttach(opts: {
  cwd: string;
  adapter?: string;
  pid?: number;
  host?: string;
  port?: number;
}): ResolvedAdapter {
  const discovered = discoverAllAdapters(opts.cwd);
  const host = opts.host ?? "127.0.0.1";

  if (opts.adapter) {
    const canonical = ADAPTER_ALIASES[opts.adapter.toLowerCase()] ?? opts.adapter;
    if (canonical === "debugpy" && opts.port !== undefined) {
      // Direct TCP connection to debugpy.listen(port)!
      return {
        name: "debugpy",
        displayName: "Python (debugpy TCP attach)",
        transport: "tcp-connect",
        languages: ["python"],
        fileExtensions: [".py"],
        host,
        port: opts.port,
        attachDefaults: { justMyCode: true },
        source: "auto-discovered",
      };
    }
    if (canonical === "debugpy" && opts.pid !== undefined) {
      const base = discovered.get("debugpy");
      if (!base) {
        throw new Error("Python debugpy adapter is not available for PID attach (install debugpy or uv).");
      }
      // Spawn debugpy --listen 127.0.0.1:0 --pid <pid> and connect via TCP!
      const args = base.command?.endsWith("uv") || base.command?.endsWith("uv.exe")
        ? ["run", "--no-project", "--with", "debugpy", "python3", "-m", "debugpy", "--listen", "127.0.0.1:0", "--pid", String(opts.pid)]
        : ["-m", "debugpy", "--listen", "127.0.0.1:0", "--pid", String(opts.pid)];
      return {
        ...base,
        displayName: "Python (debugpy PID attach)",
        transport: "tcp-spawn",
        args,
      };
    }
    const picked = discovered.get(canonical);
    if (picked) {
      return picked;
    }
    if (opts.port !== undefined) {
      return {
        name: canonical,
        displayName: `${canonical} (TCP ${host}:${opts.port})`,
        transport: "tcp-connect",
        languages: [],
        fileExtensions: [],
        host,
        port: opts.port,
        source: "explicit",
      };
    }
    throw new Error(`Adapter '${opts.adapter}' is not available for attach.`);
  }

  // Auto-detect attach target when adapter is omitted!
  if (opts.pid !== undefined && process.platform !== "win32") {
    try {
      const res = spawnSync("ps", ["-p", String(opts.pid), "-o", "comm="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      });
      const comm = (res.stdout ?? "").trim().toLowerCase();
      if (comm.includes("node")) {
        const nodeAdapter = discovered.get("node");
        if (nodeAdapter) {
          return nodeAdapter;
        }
      }
      if (comm.includes("python")) {
        return selectAdapterForAttach({ ...opts, adapter: "debugpy" });
      }
    } catch {
      // fall through
    }
  }

  if (opts.port === 9229) {
    const nodeAdapter = discovered.get("node");
    if (nodeAdapter) {
      return nodeAdapter;
    }
  }

  if (opts.port !== undefined) {
    // Generic TCP DAP server (covers debugpy --listen 5678, remote dlv dap, codelldb, etc.)
    return {
      name: "dap-tcp",
      displayName: `DAP Server (${host}:${opts.port})`,
      transport: "tcp-connect",
      languages: [],
      fileExtensions: [],
      host,
      port: opts.port,
      source: "auto-discovered",
    };
  }

  for (const fallback of ["codelldb", "lldb-dap", "gdb", "dlv", "node"]) {
    const found = discovered.get(fallback);
    if (found) {
      return found;
    }
  }

  const fallbackNode = discovered.get("node");
  if (fallbackNode) {
    return fallbackNode;
  }
  throw new Error("No compatible debug adapter found for attach.");
}

function inferLaunchOverrides(adapter: ResolvedAdapter, program: string): Record<string, unknown> {
  if (adapter.name === "dlv") {
    const base = path.basename(program).toLowerCase();
    const ext = path.extname(program).toLowerCase();
    if (base.endsWith("_test.go")) {
      return { mode: "test" };
    }
    if (ext === ".go") {
      return { mode: "debug" };
    }
    return { mode: "exec" };
  }
  return {};
}

export function runAdapterDoctor(cwd: string): AdapterDoctorEntry[] {
  const discovered = discoverAllAdapters(cwd);
  const catalog: Array<{
    name: string;
    displayName: string;
    defaultTransport: DebugTransportKind;
    languages: string[];
    installHint: string;
  }> = [
    {
      name: "node",
      displayName: "Node.js / TypeScript (Built-in V8 Inspector)",
      defaultTransport: "node-inspector",
      languages: ["javascript", "typescript"],
      installHint: "Built into Node.js >= 22.6 (always ready)",
    },
    {
      name: "debugpy",
      displayName: "Python (debugpy)",
      defaultTransport: "stdio",
      languages: ["python"],
      installHint: "Install 'uv' (zero-install auto-cache) or 'pip install debugpy'",
    },
    {
      name: "dlv",
      displayName: "Go (Delve)",
      defaultTransport: "tcp-spawn",
      languages: ["go"],
      installHint: "go install github.com/go-delve/delve/cmd/dlv@latest",
    },
    {
      name: "codelldb",
      displayName: "Rust / C / C++ / Zig (CodeLLDB)",
      defaultTransport: "tcp-spawn",
      languages: ["rust", "c", "cpp", "zig"],
      installHint: "Install Vadim Chugunov's CodeLLDB extension in VS Code / Cursor or place 'codelldb' on PATH",
    },
    {
      name: "lldb-dap",
      displayName: "C / C++ / Rust / Swift (lldb-dap)",
      defaultTransport: "stdio",
      languages: ["c", "cpp", "rust", "swift"],
      installHint: "macOS: xcode-select --install (or brew install llvm); Linux: apt install lldb",
    },
    {
      name: "gdb",
      displayName: "C / C++ / Rust (GDB >= 14 DAP)",
      defaultTransport: "stdio",
      languages: ["c", "cpp", "rust"],
      installHint: "Install GDB 14+ (gdb -i dap)",
    },
    {
      name: "netcoredbg",
      displayName: ".NET (netcoredbg)",
      defaultTransport: "stdio",
      languages: ["csharp", "fsharp"],
      installHint: "Install Samsung netcoredbg on PATH",
    },
    {
      name: "rdbg",
      displayName: "Ruby (debug gem / rdbg)",
      defaultTransport: "tcp-spawn",
      languages: ["ruby"],
      installHint: "gem install debug",
    },
  ];

  const entries: AdapterDoctorEntry[] = catalog.map((item) => {
    const active = discovered.get(item.name);
    if (active) {
      return {
        name: item.name,
        displayName: active.displayName,
        available: true,
        transport: active.transport,
        languages: active.languages,
        resolvedBinary: active.resolvedBinary,
        debuggeePython: active.debuggeePython,
        notes: active.notes,
      };
    }
    return {
      name: item.name,
      displayName: item.displayName,
      available: false,
      transport: item.defaultTransport,
      languages: item.languages,
      installHint: item.installHint,
    };
  });

  // Include any extra custom adapters from .pi/dap.json or settings.json
  for (const [name, custom] of discovered.entries()) {
    if (!entries.some((e) => e.name === name)) {
      entries.push({
        name,
        displayName: custom.displayName,
        available: true,
        transport: custom.transport,
        languages: custom.languages,
        resolvedBinary: custom.resolvedBinary,
        notes: custom.notes ?? `Configured in ${custom.source}`,
      });
    }
  }

  return entries;
}
