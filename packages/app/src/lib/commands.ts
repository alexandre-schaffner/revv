import { createServerFn } from "@tanstack/react-start";
import {
  approve,
  type CommandEntry,
  deny,
  enqueue,
  getCommand,
  getLog,
  getPending,
} from "./command-log";

/** Enqueue a command for approval. Returns the pending entry. */
export const enqueueCommand = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { block: string; cmd: string; args?: string[]; cwd?: string }) =>
      input,
  )
  .handler(async ({ data }): Promise<CommandEntry> => {
    return enqueue(data.block, data.cmd, data.args ?? [], data.cwd);
  });

/** Get a command by ID (poll for status changes). */
export const getCommandById = createServerFn({ method: "GET" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<CommandEntry | null> => {
    return getCommand(data.id);
  });

/** Get the full command log, optionally filtered by block name. */
export const getCommandLog = createServerFn({ method: "GET" })
  .inputValidator((input: { block?: string }) => input)
  .handler(async ({ data }): Promise<CommandEntry[]> => {
    return getLog(data.block);
  });

/** Get pending commands awaiting approval. */
export const getPendingCommands = createServerFn({ method: "GET" })
  .inputValidator((input: { block?: string }) => input)
  .handler(async ({ data }): Promise<CommandEntry[]> => {
    return getPending(data.block);
  });

/** Approve a pending command — executes it and returns the result. */
export const approveCommand = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<CommandEntry> => {
    return approve(data.id);
  });

/** Deny a pending command. */
export const denyCommand = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<CommandEntry> => {
    return deny(data.id);
  });
