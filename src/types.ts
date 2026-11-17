/**
 * Core types for pi-debugger: DAP wire protocol, adapter discovery,
 * unified DebugBackend (DAP + built-in V8 Inspector), multi-session state, and debug_probe.
 */

declare global {
  namespace NodeJS {
    interface Process {
      _debugProcess?(pid: number): void;
    }
  }
}

export type DebugTransportKind = "stdio" | "tcp-spawn" | "tcp-connect" | "node-inspector";

export type DebugSessionState = "starting" | "running" | "stopped" | "terminated";

export type DebugLaunchMode = "launch" | "attach";

export interface DapProtocolMessage {
  seq: number;
  type: "request" | "response" | "event";
}

export interface DapRequestMessage extends DapProtocolMessage {
  type: "request";
  command: string;
  arguments?: unknown;
}

export interface DapResponseMessage extends DapProtocolMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DapEventMessage extends DapProtocolMessage {
  type: "event";
  event: string;
  body?: unknown;
}

export type DapWireMessage = DapRequestMessage | DapResponseMessage | DapEventMessage;

export interface DapExceptionBreakpointsFilter {
  filter: string;
  label: string;
  description?: string;
  default?: boolean;
  supportsCondition?: boolean;
  conditionDescription?: string;
}

export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsSetVariable?: boolean;
  supportsCompletionsRequest?: boolean;
  supportsModulesRequest?: boolean;
  supportsRestartRequest?: boolean;
  supportsExceptionOptions?: boolean;
  supportsValueFormattingOptions?: boolean;
  supportsExceptionInfoRequest?: boolean;
  supportTerminateDebuggee?: boolean;
  supportsTerminateRequest?: boolean;
  supportsDelayedStackTraceLoading?: boolean;
  supportsLoadedSourcesRequest?: boolean;
  supportsLogPoints?: boolean;
  supportsTerminateThreadsRequest?: boolean;
  supportsSetExpression?: boolean;
  supportsDataBreakpoints?: boolean;
  supportsReadMemoryRequest?: boolean;
  supportsWriteMemoryRequest?: boolean;
  supportsDisassembleRequest?: boolean;
  supportsCancelRequest?: boolean;
  supportsBreakpointLocationsRequest?: boolean;
  supportsSteppingGranularity?: boolean;
  supportsInstructionBreakpoints?: boolean;
  exceptionBreakpointFilters?: DapExceptionBreakpointsFilter[];
  [key: string]: unknown;
}

export interface SourceBreakpointSpec {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface VerifiedBreakpoint {
  id?: number;
  verified: boolean;
  file?: string;
  line: number;
  requestedLine: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  message?: string;
}

export interface VerifiedFunctionBreakpoint {
  id?: number;
  name: string;
  verified: boolean;
  line?: number;
  condition?: string;
  hitCondition?: string;
  message?: string;
}

export interface DebugSourceRef {
  name?: string;
  path?: string;
  sourceReference?: number;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  source?: DebugSourceRef;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  instructionPointerReference?: string;
  presentationHint?: string;
}

export interface DebugThread {
  id: number;
  name: string;
}

export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
  namedVariables?: number;
  indexedVariables?: number;
  presentationHint?: string;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  evaluateName?: string;
  memoryReference?: string;
  children?: DebugVariable[];
}

export interface DebugEvaluateResult {
  expression: string;
  result: string;
  type?: string;
  variablesReference: number;
  error?: string;
  children?: DebugVariable[];
}

export interface DebugDisassembledInstruction {
  address: string;
  instructionBytes?: string;
  instruction: string;
  symbol?: string;
  line?: number;
}

export interface DebugMemoryReadResult {
  address: string;
  dataBase64: string;
  bytesRead: number;
  unreadableBytes?: number;
}

export interface DebugExceptionInfo {
  exceptionId: string;
  description?: string;
  breakMode?: string;
  details?: {
    message?: string;
    typeName?: string;
    fullTypeName?: string;
    stackTrace?: string;
  };
}

export interface DebugStoppedEvent {
  reason: string;
  description?: string;
  text?: string;
  threadId?: number;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
  exception?: DebugExceptionInfo;
}

export interface DebugOutputEvent {
  category: "stdout" | "stderr" | "console" | "telemetry" | string;
  output: string;
}

export interface SourceContextLine {
  line: number;
  text: string;
  isCurrent: boolean;
}

export interface SourceContextSnippet {
  file: string;
  startLine: number;
  endLine: number;
  currentLine: number;
  lines: SourceContextLine[];
}

export interface ResolvedAdapter {
  name: string;
  displayName: string;
  transport: DebugTransportKind;
  languages: string[];
  fileExtensions: string[];
  command?: string;
  args?: string[];
  resolvedBinary?: string;
  debuggeePython?: string;
  host?: string;
  port?: number;
  launchDefaults?: Record<string, unknown>;
  attachDefaults?: Record<string, unknown>;
  notes?: string;
  source: "builtin" | "auto-discovered" | "project-config" | "user-config" | "explicit";
}

export interface AdapterDoctorEntry {
  name: string;
  displayName: string;
  available: boolean;
  transport: DebugTransportKind;
  languages: string[];
  resolvedBinary?: string;
  debuggeePython?: string;
  notes?: string;
  installHint?: string;
}

export interface InlineBreakpointInput {
  file?: string;
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface SessionSummary {
  id: string;
  name?: string;
  active: boolean;
  mode: DebugLaunchMode;
  adapter: string;
  transport: DebugTransportKind;
  state: DebugSessionState;
  cwd: string;
  program?: string;
  pid?: number;
  host?: string;
  port?: number;
  stoppedReason?: string;
  activeThreadId?: number;
  breakpointCount: number;
  exitCode?: number | null;
  startedAt: number;
}

export interface StopLocationInfo {
  file: string;
  line: number;
  column?: number;
  functionName: string;
  snippet?: SourceContextSnippet;
}

export interface StopSnapshot {
  sessionId: string;
  adapter: string;
  mode: DebugLaunchMode;
  state: DebugSessionState;
  stopped?: DebugStoppedEvent;
  location?: StopLocationInfo;
  stack?: DebugStackFrame[];
  scopes?: DebugScope[];
  locals?: DebugVariable[];
  exitCode?: number | null;
  recentOutput?: string;
}

export interface ProbeBreakpointInput {
  file?: string;
  line: number;
  condition?: string;
  hitCondition?: string;
  expressions?: string[];
}

export interface ProbeOptions {
  cwd: string;
  program: string;
  args?: string[];
  adapter?: string;
  pythonPath?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  breakpoints?: ProbeBreakpointInput[];
  breakOnExceptions?: "none" | "uncaught" | "all";
  expressions?: string[];
  maxHits?: number;
  maxDepth?: number;
  timeoutMs?: number;
}

export interface ProbeHitSnapshot {
  hitIndex: number;
  reason: string;
  description?: string;
  file?: string;
  line?: number;
  functionName?: string;
  snippet?: SourceContextSnippet;
  stack: DebugStackFrame[];
  locals: DebugVariable[];
  evaluations: DebugEvaluateResult[];
  exception?: DebugExceptionInfo;
}

export interface ProbeResult {
  adapter: string;
  program: string;
  completed: boolean;
  timedOut: boolean;
  exitCode?: number | null;
  hits: ProbeHitSnapshot[];
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Backend contract implemented by both DapBackend (standard DAP over stdio/TCP)
 * and NodeInspectorBackend (zero-config V8 Inspector over WebSocket CDP).
 */
export interface DebugBackendCallbacks {
  onStopped: (event: DebugStoppedEvent) => void;
  onContinued: (threadId?: number) => void;
  onOutput: (event: DebugOutputEvent) => void;
  onExited: (exitCode?: number) => void;
  onTerminated: () => void;
}

export interface DebugBackend {
  readonly adapter: ResolvedAdapter;
  readonly capabilities: DapCapabilities;
  isAlive(): boolean;
  startLaunch(
    opts: {
      program: string;
      args?: string[];
      cwd: string;
      env?: Record<string, string>;
      stopOnEntry?: boolean;
      launchArgs?: Record<string, unknown>;
      initialBreakpoints: Map<string, SourceBreakpointSpec[]>;
      initialFunctionBreakpoints: Array<{ name: string; condition?: string }>;
      exceptionFilters?: string[];
    },
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ verifiedBreakpoints: VerifiedBreakpoint[]; verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[] }>;
  startAttach(
    opts: {
      cwd: string;
      pid?: number;
      host?: string;
      port?: number;
      program?: string;
      attachArgs?: Record<string, unknown>;
      initialBreakpoints: Map<string, SourceBreakpointSpec[]>;
      initialFunctionBreakpoints: Array<{ name: string; condition?: string }>;
      exceptionFilters?: string[];
    },
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ verifiedBreakpoints: VerifiedBreakpoint[]; verifiedFunctionBreakpoints: VerifiedFunctionBreakpoint[] }>;
  setSourceBreakpoints(file: string, specs: SourceBreakpointSpec[], signal?: AbortSignal, timeoutMs?: number): Promise<VerifiedBreakpoint[]>;
  setFunctionBreakpoints(specs: Array<{ name: string; condition?: string }>, signal?: AbortSignal, timeoutMs?: number): Promise<VerifiedFunctionBreakpoint[]>;
  setExceptionBreakpoints(filters: string[], signal?: AbortSignal, timeoutMs?: number): Promise<void>;
  continueExecution(threadId?: number, signal?: AbortSignal, timeoutMs?: number): Promise<void>;
  pauseExecution(threadId?: number, signal?: AbortSignal, timeoutMs?: number): Promise<void>;
  stepOver(threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<void>;
  stepIn(threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<void>;
  stepOut(threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<void>;
  threads(signal?: AbortSignal, timeoutMs?: number): Promise<DebugThread[]>;
  stackTrace(threadId: number, levels?: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugStackFrame[]>;
  scopes(frameId: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugScope[]>;
  variables(variablesReference: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugVariable[]>;
  evaluate(expression: string, frameId?: number, context?: string, signal?: AbortSignal, timeoutMs?: number): Promise<DebugEvaluateResult>;
  exceptionInfo(threadId: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugExceptionInfo | undefined>;
  disassemble?(memoryReference: string, instructionCount: number, offset?: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugDisassembledInstruction[]>;
  readMemory?(memoryReference: string, count: number, offset?: number, signal?: AbortSignal, timeoutMs?: number): Promise<DebugMemoryReadResult>;
  customRequest?(command: string, args?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
  disconnect(opts: { terminateDebuggee: boolean }, signal?: AbortSignal, timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}
