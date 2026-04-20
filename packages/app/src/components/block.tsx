import { useMemo, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Spinner } from "@rev/ui/components/ui/spinner";
import { Button } from "@rev/ui/components/ui/button";
import { RefreshCw } from "lucide-react";
import {
  useRegisterShortcuts,
  type ShortcutDef,
  type ShortcutKey,
} from "../lib/shortcuts";

interface BlockProps<T> {
  /** Block identifier for shortcuts and display. */
  name: string;
  /** TanStack Query result. */
  query: UseQueryResult<T>;
  /** Render function for success state. */
  children: (data: T) => ReactNode;
  /** Message for empty state (when data is empty array). */
  empty?: string;
  /** Keyboard shortcut for refresh. */
  refreshShortcut?: { keys: ShortcutKey; mode?: string };
  /** Additional shortcuts for this block. */
  shortcuts?: ShortcutDef[];
}

export function Block<T>({
  name,
  query,
  children,
  empty,
  refreshShortcut,
  shortcuts: extraShortcuts,
}: BlockProps<T>) {
  const { data, isLoading, isError, error, isFetching, refetch } = query;

  // Register shortcuts
  const shortcuts = useMemo<ShortcutDef[]>(() => {
    const all: ShortcutDef[] = [];
    if (refreshShortcut) {
      const shortcut: ShortcutDef = {
        id: `${name}:refresh`,
        label: "Refresh",
        keys: refreshShortcut.keys,
        category: name,
        action: () => { refetch(); },
      };
      if (refreshShortcut.mode) shortcut.mode = refreshShortcut.mode;
      all.push(shortcut);
    }
    if (extraShortcuts) all.push(...extraShortcuts);
    return all;
  }, [name, refreshShortcut, extraShortcuts, refetch]);

  useRegisterShortcuts(shortcuts);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-end px-3 py-1 shrink-0">
        <button
          type="button"
          onClick={() => refetch()}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {isFetching && !isLoading && (
            <RefreshCw className="h-2.5 w-2.5 animate-spin" />
          )}
          refresh
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full gap-2">
            <Spinner className="h-4 w-4" />
            <span className="text-xs text-muted-foreground">Loading...</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <span className="text-xs text-destructive">
              {error instanceof Error ? error.message : "Failed to load."}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px]"
              onClick={() => refetch()}
            >
              Retry
            </Button>
          </div>
        ) : data != null &&
          empty &&
          Array.isArray(data) &&
          data.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs text-muted-foreground">{empty}</span>
          </div>
        ) : data != null ? (
          children(data)
        ) : null}
      </div>
    </div>
  );
}
