import type { ShellResult } from "./shell";
import { exec as rawExec } from "./shell";

export type CommandStatus =
  | "pending"
  | "approved"
  | "denied"
  | "running"
  | "done"
  | "error";

export interface CommandEntry {
  id: string;
  block: string;
  cmd: string;
  args: string[];
  cwd: string;
  status: CommandStatus;
  result: ShellResult | null;
  createdAt: number;
  finishedAt: number | null;
}

let counter = 0;
const log: CommandEntry[] = [];

function nextId(): string {
  return `cmd_${++counter}_${Date.now()}`;
}

/** Push a command into the log as pending. Returns the entry. */
export function enqueue(
  block: string,
  cmd: string,
  args: string[] = [],
  cwd?: string,
): CommandEntry {
  const entry: CommandEntry = {
    id: nextId(),
    block,
    cmd,
    args,
    cwd: cwd ?? process.cwd(),
    status: "pending",
    result: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  log.push(entry);
  return entry;
}

/** Approve and execute a pending command. */
export async function approve(id: string): Promise<CommandEntry> {
  const entry = log.find((e) => e.id === id);
  if (!entry) throw new Error(`Command ${id} not found`);
  if (entry.status !== "pending")
    throw new Error(`Command ${id} is ${entry.status}, not pending`);

  entry.status = "running";
  const result = await rawExec(entry.cmd, entry.args, { cwd: entry.cwd });
  entry.result = result;
  entry.status = result.code === 0 ? "done" : "error";
  entry.finishedAt = Date.now();
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
  return entry;
}

/** Shortcut: enqueue + approve in one call. For commands that don't need gating. */
export async function run(
  block: string,
  cmd: string,
  args: string[] = [],
  cwd?: string,
): Promise<CommandEntry> {
  const entry = enqueue(block, cmd, args, cwd);
  return approve(entry.id);
}

/** Get the full log, optionally filtered by block. */
export function getLog(block?: string): CommandEntry[] {
  if (block) return log.filter((e) => e.block === block);
  return [...log];
}

/** Get a single command by ID. */
export function getCommand(id: string): CommandEntry | null {
  return log.find((e) => e.id === id) ?? null;
}

/** Get pending commands awaiting approval. */
export function getPending(block?: string): CommandEntry[] {
  return getLog(block).filter((e) => e.status === "pending");
}
