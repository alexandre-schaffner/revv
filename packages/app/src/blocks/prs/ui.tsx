import { useState, useEffect, useCallback, useMemo } from "react";
import { requestPrList } from "./commands";
import { Spinner } from "@rev/ui/components/ui/spinner";
import { PRList, type PrEntry } from "./ui/pr";
import { useRegisterShortcuts, type ShortcutDef } from "../../lib/shortcuts";

export function PrsBlock() {
  const [prs, setPrs] = useState<PrEntry[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );

  const requestPrs = useCallback(async () => {
    setStatus("loading");
    setPrs([]);
    const entry = await requestPrList();
    try {
      const parsed = JSON.parse(
        entry.result?.stdout ?? "[]",
      ) as PrEntry[];
      setPrs(parsed);
    } catch {
      setPrs([]);
    }
    setStatus(entry.status === "done" ? "done" : "error");
  }, []);

  useEffect(() => {
    requestPrs();
  }, [requestPrs]);

  const shortcuts = useMemo<ShortcutDef[]>(
    () => [
      { id: "prs:refresh", label: "Refresh", keys: { mod: true, shift: true, key: "r" }, mode: "sidebar", category: "PRs", action: requestPrs },
    ],
    [requestPrs],
  );

  useRegisterShortcuts(shortcuts);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-end px-3 py-1">
        <button
          type="button"
          onClick={requestPrs}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          refresh
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {status === "loading" && (
          <div className="flex items-center justify-center h-full gap-2">
            <Spinner className="h-4 w-4" />
            <span className="text-xs text-muted-foreground">
              Loading…
            </span>
          </div>
        )}
        {status === "error" && (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs text-muted-foreground">
              Failed to fetch PRs.
            </span>
          </div>
        )}
        {status === "done" && (
          <PRList prs={prs} emptyMessage="No open pull requests." />
        )}
      </div>
    </div>
  );
}
