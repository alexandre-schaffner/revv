import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { createServerFn } from "@tanstack/react-start";
import { queryClient } from "./query-client";

// ── Module-level getter for queryOptions ─────────────────
// queryOptions() can't access React context, so we keep a
// module-level reference. Safe: desktop app, single window.

let _currentWorktree: string | undefined;

export function getCurrentWorktree(): string | undefined {
  return _currentWorktree;
}

export function setCurrentWorktree(path: string | undefined) {
  _currentWorktree = path;
}

// ── Server function to get initial cwd ───────────────────

const getServerCwd = createServerFn({ method: "GET" }).handler(async () => {
  return process.cwd();
});

// ── React context ────────────────────────────────────────

interface WorktreeContextValue {
  path: string;
  setPath: (path: string) => void;
}

const WorktreeContext = createContext<WorktreeContextValue | null>(null);

export function WorktreeProvider({ children }: { children: ReactNode }) {
  const [path, setPathState] = useState<string>("");

  const setPath = useCallback((newPath: string) => {
    setPathState(newPath);
    setCurrentWorktree(newPath);
    if (typeof window !== "undefined") {
      localStorage.setItem("rev-worktree", newPath);
    }
    // All data from old worktree is stale
    queryClient.invalidateQueries();
  }, []);

  // Sync module-level variable whenever path changes
  useEffect(() => {
    if (path) setCurrentWorktree(path);
  }, [path]);

  // Initialize: try localStorage, then ask server
  useEffect(() => {
    const stored =
      typeof window !== "undefined"
        ? localStorage.getItem("rev-worktree")
        : null;

    if (stored) {
      setPathState(stored);
      setCurrentWorktree(stored);
    } else {
      getServerCwd().then((cwd) => {
        setPathState(cwd);
        setCurrentWorktree(cwd);
      });
    }
  }, []);

  return (
    <WorktreeContext.Provider value={{ path, setPath }}>
      {children}
    </WorktreeContext.Provider>
  );
}

export function useWorktree(): WorktreeContextValue {
  const ctx = useContext(WorktreeContext);
  if (!ctx)
    throw new Error("useWorktree must be used within WorktreeProvider");
  return ctx;
}
