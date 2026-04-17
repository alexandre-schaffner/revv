import { useState, useEffect, useCallback, useRef } from "react";
import { requestPrList } from "./commands";
import { getCommandById } from "../../lib/commands";
import { Spinner } from "@rev/ui/components/ui/spinner";
import { PRList, type PrEntry } from "./ui/pr";

export function PrsBlock() {
  const [prs, setPrs] = useState<PrEntry[]>([]);
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "denied">(
    "idle",
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const requestPrs = useCallback(async () => {
    setStatus("pending");
    setPrs([]);
    const entry = await requestPrList();
    pollRef.current = setInterval(async () => {
      const updated = await getCommandById({ data: { id: entry.id } });
      if (!updated) return;
      if (updated.status === "done" || updated.status === "error") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        try {
          const parsed = JSON.parse(
            updated.result?.stdout ?? "[]",
          ) as PrEntry[];
          setPrs(parsed);
        } catch {
          setPrs([]);
        }
        setStatus("done");
      } else if (updated.status === "denied") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setStatus("denied");
      }
    }, 500);
  }, []);

  useEffect(() => {
    requestPrs();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [requestPrs]);

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
        {status === "pending" && (
          <div className="flex items-center justify-center h-full gap-2">
            <Spinner className="h-4 w-4" />
            <span className="text-xs text-muted-foreground">
              Awaiting approval…
            </span>
          </div>
        )}
        {status === "denied" && (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs text-muted-foreground">
              Command denied.
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
