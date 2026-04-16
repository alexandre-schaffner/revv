import { useState, useEffect, useCallback } from "react";
import {
  getPendingCommands,
  approveCommand,
  denyCommand,
} from "../../lib/commands";
import type { CommandEntry } from "../../lib/command-log";

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

  const handleApprove = async (cmdId: string) => {
    await approveCommand({ data: { id: cmdId } });
    poll();
  };

  const handleDeny = async (cmdId: string) => {
    await denyCommand({ data: { id: cmdId } });
    poll();
  };

  if (pending.length === 0) {
    return (
      <span className="text-xs text-muted-foreground/50 font-mono">
        no pending commands
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {pending.map((entry) => (
        <div
          key={entry.id}
          className="flex items-center gap-2 text-xs font-mono"
        >
          <span className="text-muted-foreground shrink-0">{entry.block}</span>
          <span className="text-foreground truncate">
            {entry.cmd}{entry.args.length > 0 ? ` ${entry.args.join(" ")}` : ""}
          </span>
          <div className="ml-auto flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => handleApprove(entry.id)}
              className="px-2 py-0.5 rounded-sm bg-foreground text-background text-[10px] font-medium hover:bg-foreground/80 transition-colors cursor-pointer"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => handleDeny(entry.id)}
              className="p-0.5 rounded-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
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
