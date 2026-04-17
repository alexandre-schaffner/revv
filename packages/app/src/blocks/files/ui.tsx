import { useState, useEffect, useCallback, useRef } from "react";
import { requestLs } from "./commands";
import { getCommandById } from "../../lib/commands";
import type { CommandEntry } from "../../lib/command-log";

interface FileEntry {
  permissions: string;
  name: string;
  isDir: boolean;
}

function parseLsLine(line: string): FileEntry | null {
  // ls -la output: permissions links owner group size month day time name
  const parts = line.split(/\s+/);
  if (parts.length < 9) return null;
  const permissions = parts[0]!;
  if (!permissions.startsWith("d") && !permissions.startsWith("-") && !permissions.startsWith("l")) return null;
  const name = parts.slice(8).join(" ");
  if (name === "." || name === "..") return null;
  return {
    permissions,
    name,
    isDir: permissions.startsWith("d"),
  };
}

export function FilesBlock() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "denied">("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const requestFiles = useCallback(async () => {
    setStatus("pending");
    setFiles([]);
    const entry = await requestLs();
    // poll for completion
    pollRef.current = setInterval(async () => {
      const updated = await getCommandById({ data: { id: entry.id } });
      if (!updated) return;
      if (updated.status === "done" || updated.status === "error") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        const lines = (updated.result?.stdout ?? "").split("\n");
        setFiles(lines.map(parseLsLine).filter((f): f is FileEntry => f !== null));
        setStatus("done");
      } else if (updated.status === "denied") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setStatus("denied");
      }
    }, 500);
  }, []);

  useEffect(() => {
    requestFiles();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [requestFiles]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-end px-3 py-1">
        <button
          type="button"
          onClick={requestFiles}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          refresh
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {status === "pending" && (
          <span className="px-3 py-2 text-xs text-muted-foreground block">
            Awaiting approval…
          </span>
        )}
        {status === "denied" && (
          <span className="px-3 py-2 text-xs text-muted-foreground block">
            Command denied.
          </span>
        )}
        {status === "done" && files.length === 0 && (
          <span className="px-3 py-2 text-xs text-muted-foreground block">
            Empty directory.
          </span>
        )}
        {files.map((file) => (
          <div
            key={file.name}
            className="flex items-center gap-2 px-3 py-0.5 text-xs font-mono hover:bg-accent/50 transition-colors"
          >
            <span className="text-muted-foreground w-3 text-center shrink-0">
              {file.isDir ? "d" : " "}
            </span>
            <span className={file.isDir ? "text-foreground" : "text-muted-foreground"}>
              {file.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
