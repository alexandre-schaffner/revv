import { createServerFn } from "@tanstack/react-start";
import { approve, type CommandEntry, deny, getCommand, getPending } from "./command-log";

/** Get a command by ID (poll for status changes). */
export const getCommandById = createServerFn({ method: "GET" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<CommandEntry | null> => {
    return getCommand(data.id);
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
