import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  getPendingCommands,
  approveCommand,
  denyCommand,
} from "../../lib/commands";
import type { CommandEntry } from "../../lib/command-log";
import { Button } from "@rev/ui/components/ui/button";
import { useRegisterShortcuts, formatKeysString, type ShortcutDef } from "../../lib/shortcuts";
import { ShortcutKbd } from "../../components/shortcut-kbd";
import { Terminal, Check } from "lucide-react";

type CmdPhase = "idle" | "exiting" | "entering";

export function ApprovalBlock() {
  const [pending, setPending] = useState<CommandEntry[]>([]);
  const [cmdPhase, setCmdPhase] = useState<CmdPhase>("idle");
  const [ringKey, setRingKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const poll = useCallback(() => {
    getPendingCommands({ data: {} }).then(setPending);
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleApprove = useCallback(
    async (cmdId: string) => {
      if (cmdPhase !== "idle") return;
      setRingKey((k) => k + 1);
      setCmdPhase("exiting");
      approveCommand({ data: { id: cmdId } });

      timerRef.current = setTimeout(() => {
        poll();
        setCmdPhase("entering");

        timerRef.current = setTimeout(() => {
          setCmdPhase("idle");
        }, 200);
      }, 150);
    },
    [poll, cmdPhase],
  );

  const handleDeny = useCallback(
    async (cmdId: string) => {
      await denyCommand({ data: { id: cmdId } });
      poll();
    },
    [poll],
  );

  const hasPending = pending.length > 0;
  const firstId = pending[0]?.id;

  const shortcuts = useMemo<ShortcutDef[]>(
    () =>
      hasPending && firstId
        ? [
            {
              id: "approval:accept",
              label: "Accept Command",
              keys: { mod: true, key: "a" },
              category: "Approval",
              action: () => handleApprove(firstId),
            },
            {
              id: "approval:deny",
              label: "Deny Command",
              keys: { mod: true, key: "d" },
              category: "Approval",
              action: () => handleDeny(firstId),
            },
          ]
        : [],
    [hasPending, firstId, handleApprove, handleDeny],
  );

  useRegisterShortcuts(shortcuts);

  if (pending.length === 0) {
    return (
      <span className="text-xs text-muted-foreground/50 font-mono">
        no pending commands
      </span>
    );
  }

  const entry = pending[0]!;
  const isExiting = cmdPhase === "exiting";
  const isEntering = cmdPhase === "entering";

  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      {/* Command text — slides down & fades out, next one fades in */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <div
          className={`flex items-center gap-2 transition-all duration-150 ease-out ${
            isExiting
              ? "opacity-0 translate-x-3"
              : isEntering
                ? "animate-[enterIn_200ms_ease-out_both]"
                : "opacity-100 translate-x-0"
          }`}
        >
          <span className="relative shrink-0 w-3.5 h-3.5">
            <Terminal
              className={`absolute inset-0 w-3.5 h-3.5 text-muted-foreground transition-opacity duration-150 ${
                isExiting ? "opacity-0" : "opacity-100"
              }`}
            />
            <Check
              className={`absolute inset-0 w-3.5 h-3.5 text-emerald-500 transition-opacity duration-150 ${
                isExiting ? "opacity-100" : "opacity-0"
              }`}
            />
          </span>

          <span className="text-muted-foreground shrink-0">{entry.block}</span>
          <span className="text-foreground truncate">
            {entry.cmd}{entry.args.length > 0 ? ` ${entry.args.join(" ")}` : ""}
          </span>
          {pending.length > 1 && (
            <span className="text-muted-foreground/50 shrink-0">
              +{pending.length - 1}
            </span>
          )}
        </div>
      </div>

      {/* Buttons — stay in place, ring flash only */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="relative inline-flex">
          <span key={ringKey} className={`absolute -inset-[3px] rounded-md border border-emerald-500 pointer-events-none ${ringKey > 0 ? "animate-[ringFlash_200ms_ease-out_forwards]" : "opacity-0"}`} />
          <Button
            variant="default"
            size="sm"
            className="relative h-5 px-2 text-[10px] rounded-sm"
            onClick={() => handleApprove(entry.id)}
          >
            Accept
            <ShortcutKbd shortcut="approval:accept" className="ml-1 h-3.5 text-[9px] bg-primary-foreground/20 text-primary-foreground" />
          </Button>
        </span>
        <button
          type="button"
          onClick={() => handleDeny(entry.id)}
          className="p-0.5 rounded-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          title={`Deny (${formatKeysString({ mod: true, key: "d" })})`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>

      <style>{`
        @keyframes enterIn {
          from { opacity: 0; transform: translateX(-8px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes ringFlash {
          0% { opacity: 0.8; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
