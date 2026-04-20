import { exec } from "./shell";
import type { ShellResult } from "./shell";

// ── Types ────────────────────────────────────────────────

export type CommandStatus =
  | "pending"
  | "denied"
  | "running"
  | "done"
  | "error";

export type Gate = "auto" | "confirm";

export interface CommandEntry {
  id: string;
  name: string;
  bin: string;
  args: string[];
  cwd: string;
  gate: Gate;
  status: CommandStatus;
  result: ShellResult | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// ── In-memory ring buffer ────────────────────────────────

const MAX_LOG_SIZE = 500;
const log: CommandEntry[] = [];
let idCounter = 0;

function nextId(): string {
  return `cmd_${++idCounter}_${Date.now()}`;
}

function pushEntry(entry: CommandEntry) {
  log.push(entry);
  if (log.length > MAX_LOG_SIZE) {
    log.splice(0, log.length - MAX_LOG_SIZE);
  }
}

// ── Event subscription ───────────────────────────────────

type LogEvent = "enqueue" | "update";
type LogListener = (event: LogEvent, entry: CommandEntry) => void;

const listeners = new Set<LogListener>();

export function subscribe(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: LogEvent, entry: CommandEntry) {
  for (const fn of listeners) fn(event, entry);
}

// ── Promise-based approval callbacks ─────────────────────

const pendingCallbacks = new Map<
  string,
  { resolve: (result: ShellResult) => void; reject: (reason: string) => void }
>();

// ── Core operations ──────────────────────────────────────

/** Push a command into the log as pending. */
export function enqueue(
  name: string,
  bin: string,
  args: string[] = [],
  cwd?: string,
  gate: Gate = "auto",
): CommandEntry {
  const entry: CommandEntry = {
    id: nextId(),
    name,
    bin,
    args,
    cwd: cwd ?? process.cwd(),
    gate,
    status: "pending",
    result: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
  pushEntry(entry);
  emit("enqueue", entry);
  return entry;
}

/** Execute a pending command. */
export async function approve(id: string): Promise<CommandEntry> {
  const entry = log.find((e) => e.id === id);
  if (!entry) throw new Error(`Command ${id} not found`);
  if (entry.status !== "pending")
    throw new Error(`Command ${id} is ${entry.status}, not pending`);

  entry.status = "running";
  entry.startedAt = Date.now();
  emit("update", entry);

  const result = await exec(entry.bin, entry.args, { cwd: entry.cwd });
  entry.result = result;
  entry.status = result.exitCode === 0 ? "done" : "error";
  entry.finishedAt = Date.now();
  emit("update", entry);

  // Resolve any waiting gated promise
  const cb = pendingCallbacks.get(id);
  if (cb) {
    if (entry.status === "done") cb.resolve(result);
    else cb.reject(result.stderr || `Exit code ${result.exitCode}`);
    pendingCallbacks.delete(id);
  }

  return entry;
}

/** Deny a pending command. */
export function deny(id: string): CommandEntry {
  const entry = log.find((e) => e.id === id);
  if (!entry) throw new Error(`Command ${id} not found`);
  if (entry.status !== "pending")
    throw new Error(`Command ${id} is ${entry.status}, not pending`);

  entry.status = "denied";
  entry.finishedAt = Date.now();
  emit("update", entry);

  // Reject any waiting gated promise
  const cb = pendingCallbacks.get(id);
  if (cb) {
    cb.reject("denied");
    pendingCallbacks.delete(id);
  }

  return entry;
}

/**
 * Enqueue + approve in one call. For auto-gate commands.
 */
export async function run(
  name: string,
  bin: string,
  args: string[] = [],
  cwd?: string,
): Promise<CommandEntry> {
  const entry = enqueue(name, bin, args, cwd, "auto");
  return approve(entry.id);
}

/**
 * Enqueue a gated command. Returns a promise that resolves with the
 * ShellResult when the command is approved+executed, or rejects when denied.
 * The mutation stays in `isPending` until the user acts.
 */
export function enqueueGated(
  name: string,
  bin: string,
  args: string[] = [],
  cwd?: string,
): { entry: CommandEntry; result: Promise<ShellResult> } {
  const entry = enqueue(name, bin, args, cwd, "confirm");
  const result = new Promise<ShellResult>((resolve, reject) => {
    pendingCallbacks.set(entry.id, { resolve, reject });
  });
  return { entry, result };
}

// ── Queries ──────────────────────────────────────────────

/** Get the full log, optionally filtered by command name prefix. */
export function getLog(namePrefix?: string): CommandEntry[] {
  if (namePrefix) return log.filter((e) => e.name.startsWith(namePrefix));
  return [...log];
}

/** Get a single command by ID. */
export function getCommand(id: string): CommandEntry | null {
  return log.find((e) => e.id === id) ?? null;
}

/** Get pending commands awaiting approval. */
export function getPending(): CommandEntry[] {
  return log.filter((e) => e.status === "pending");
}
