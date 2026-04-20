import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getLog, type CommandEntry, type CommandStatus } from "../../lib/command-log";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rev/ui/components/ui/table";
import { Badge } from "@rev/ui/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rev/ui/components/ui/collapsible";

// ── Server function ──────────────────────────────────────

const getCommandLog = createServerFn({ method: "GET" }).handler(
  async (): Promise<CommandEntry[]> => getLog(),
);

// ── Helpers ──────────────────────────────────────────────

function statusVariant(
  status: CommandStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "done":
      return "default";
    case "error":
      return "destructive";
    case "denied":
      return "destructive";
    case "pending":
      return "outline";
    case "running":
      return "secondary";
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ── Component ────────────────────────────────────────────

export function HistoryBlock() {
  const { data: entries = [] } = useQuery({
    queryKey: ["_history"],
    queryFn: () => getCommandLog(),
    refetchInterval: 1000,
  });

  if (entries.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No commands logged yet.
      </div>
    );
  }

  const sorted = [...entries].reverse();

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-medium">Command History</h2>
        <p className="text-xs text-muted-foreground">
          {entries.length} command{entries.length !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-4 text-xs">Time</TableHead>
              <TableHead className="h-8 px-4 text-xs">Command</TableHead>
              <TableHead className="h-8 px-4 text-xs">Status</TableHead>
              <TableHead className="h-8 px-4 text-xs">Exit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((entry) => (
              <CommandRow key={entry.id} entry={entry} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CommandRow({ entry }: { entry: CommandEntry }) {
  const hasOutput =
    entry.result &&
    (entry.result.stdout.length > 0 || entry.result.stderr.length > 0);
  const cmdStr = [entry.bin, ...entry.args].join(" ");

  if (!hasOutput) {
    return (
      <TableRow>
        <TableCell className="py-1.5 px-4 text-xs font-mono text-muted-foreground whitespace-nowrap">
          {formatTime(entry.createdAt)}
        </TableCell>
        <TableCell className="py-1.5 px-4 text-xs font-mono max-w-md truncate">
          <span className="text-muted-foreground">{entry.name}</span>{" "}
          {cmdStr}
        </TableCell>
        <TableCell className="py-1.5 px-4">
          <Badge
            variant={statusVariant(entry.status)}
            className="text-[10px] px-1.5 py-0"
          >
            {entry.status}
          </Badge>
        </TableCell>
        <TableCell className="py-1.5 px-4 text-xs font-mono text-muted-foreground">
          {entry.result ? entry.result.exitCode : "\u2014"}
        </TableCell>
      </TableRow>
    );
  }

  return (
    <Collapsible asChild>
      <>
        <TableRow className="cursor-pointer">
          <TableCell className="py-1.5 px-4 text-xs font-mono text-muted-foreground whitespace-nowrap">
            {formatTime(entry.createdAt)}
          </TableCell>
          <TableCell className="py-1.5 px-4 text-xs font-mono max-w-md">
            <CollapsibleTrigger className="flex items-center gap-1.5 text-left cursor-pointer hover:text-foreground transition-colors w-full">
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="shrink-0 transition-transform [[data-state=open]_&]:rotate-90"
              >
                <path d="M3 1.5l4 3.5-4 3.5" />
              </svg>
              <span className="text-muted-foreground">{entry.name}</span>{" "}
              <span className="truncate">{cmdStr}</span>
            </CollapsibleTrigger>
          </TableCell>
          <TableCell className="py-1.5 px-4">
            <Badge
              variant={statusVariant(entry.status)}
              className="text-[10px] px-1.5 py-0"
            >
              {entry.status}
            </Badge>
          </TableCell>
          <TableCell className="py-1.5 px-4 text-xs font-mono text-muted-foreground">
            {entry.result ? entry.result.exitCode : "\u2014"}
          </TableCell>
        </TableRow>
        <CollapsibleContent asChild>
          <tr>
            <td colSpan={4} className="p-0">
              <div className="bg-muted/50 border-y border-border px-4 py-2 space-y-2">
                {entry.result!.stdout && (
                  <div>
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      stdout
                    </span>
                    <pre className="mt-0.5 text-xs font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto text-foreground">
                      {entry.result!.stdout}
                    </pre>
                  </div>
                )}
                {entry.result!.stderr && (
                  <div>
                    <span className="text-[10px] font-medium text-destructive uppercase tracking-wider">
                      stderr
                    </span>
                    <pre className="mt-0.5 text-xs font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto text-destructive/80">
                      {entry.result!.stderr}
                    </pre>
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground font-mono">
                  cwd: {entry.cwd}
                  {entry.result &&
                    entry.finishedAt &&
                    ` \u00b7 ${entry.result.durationMs}ms`}
                </div>
              </div>
            </td>
          </tr>
        </CollapsibleContent>
      </>
    </Collapsible>
  );
}
