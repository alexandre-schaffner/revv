import { useState, useEffect } from "react";
import { getCwd, setCwd, getGitRepos } from "../lib/commands";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@rev/ui/components/ui/popover";

export function CwdBlock() {
  const [cwd, setCwdState] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getCwd().then(setCwdState);
  }, []);

  useEffect(() => {
    if (open) {
      getGitRepos().then(setRepos);
    }
  }, [open]);

  const handleSelect = async (path: string) => {
    const newCwd = await setCwd({ data: { path } });
    setCwdState(newCwd);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {cwd ?? "…"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-auto max-w-md p-1">
        <div className="flex flex-col">
          {repos.length === 0 && (
            <span className="px-3 py-2 text-xs text-muted-foreground">
              Scanning…
            </span>
          )}
          {repos.map((repo) => (
            <button
              key={repo}
              type="button"
              onClick={() => handleSelect(repo)}
              className={`text-left px-3 py-1.5 text-xs font-mono rounded-sm hover:bg-accent hover:text-accent-foreground transition-colors ${
                repo === cwd
                  ? "text-foreground font-medium"
                  : "text-muted-foreground"
              }`}
            >
              {repo}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
