import { useState, useEffect, useCallback, useMemo } from "react";
import { requestLs } from "./commands";
import { useRegisterShortcuts, type ShortcutDef } from "../../lib/shortcuts";

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
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  const requestFiles = useCallback(async () => {
    setStatus("loading");
    setFiles([]);
    const entry = await requestLs();
    const lines = (entry.result?.stdout ?? "").split("\n");
    setFiles(lines.map(parseLsLine).filter((f): f is FileEntry => f !== null));
    setStatus(entry.status === "done" ? "done" : "error");
  }, []);

  useEffect(() => {
    requestFiles();
  }, [requestFiles]);

  const shortcuts = useMemo<ShortcutDef[]>(
    () => [
      { id: "files:refresh", label: "Refresh", keys: { mod: true, shift: true, key: "r" }, mode: "sidebar", category: "Files", action: requestFiles },
    ],
    [requestFiles],
  );

  useRegisterShortcuts(shortcuts);

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
        {status === "loading" && (
          <span className="px-3 py-2 text-xs text-muted-foreground block">
            Loading…
          </span>
        )}
        {status === "error" && (
          <span className="px-3 py-2 text-xs text-muted-foreground block">
            Failed to list files.
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
