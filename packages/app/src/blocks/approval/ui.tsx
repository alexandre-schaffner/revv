import { useState, useEffect, useCallback } from "react";
import {
  getPendingCommands,
  approveCommand,
  denyCommand,
} from "../../lib/commands";
import type { CommandEntry } from "../../lib/command-log";
import { Button } from "@rev/ui/components/ui/button";
import { Kbd } from "@rev/ui/components/ui/kbd";

export function ApprovalBlock() {
  const [pending, setPending] = useState<CommandEntry[]>([]);

  const poll = useCallback(() => {
    getPendingCommands({ data: {} }).then(setPending);
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [poll]);

  const handleApprove = useCallback(
    async (cmdId: string) => {
      await approveCommand({ data: { id: cmdId } });
      poll();
    },
    [poll],
  );

  const handleDeny = useCallback(
    async (cmdId: string) => {
      await denyCommand({ data: { id: cmdId } });
      poll();
    },
    [poll],
  );

  // Cmd+A approves the first pending command
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "a" && pending.length > 0) {
        e.preventDefault();
        handleApprove(pending[0]!.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pending, handleApprove]);

  // Cmd+D denies the first pending command
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "d" && pending.length > 0) {
        e.preventDefault();
        handleDeny(pending[0]!.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pending, handleDeny]);

  if (pending.length === 0) {
    return (
      <span className="text-xs text-muted-foreground/50 font-mono">
        no pending commands
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {pending.map((entry, i) => (
        <div
          key={entry.id}
          className="flex items-center gap-2 text-xs font-mono"
        >
          <span className="text-muted-foreground shrink-0">{entry.block}</span>
          <span className="text-foreground truncate">
            {entry.cmd}{entry.args.length > 0 ? ` ${entry.args.join(" ")}` : ""}
          </span>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <Button
              variant="default"
              size="sm"
              className="h-5 px-2 text-[10px] rounded-sm"
              onClick={() => handleApprove(entry.id)}
            >
              Accept
              {i === 0 && <Kbd className="ml-1 h-3.5 text-[9px] bg-primary-foreground/20 text-primary-foreground">&#8984;A</Kbd>}
            </Button>
            <button
              type="button"
              onClick={() => handleDeny(entry.id)}
              className="p-0.5 rounded-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              title={i === 0 ? "Deny (⌘D)" : "Deny"}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
