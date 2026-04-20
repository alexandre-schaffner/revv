import { useQuery } from "@tanstack/react-query";
import { listGitRepos } from "./commands";
import { useWorktree } from "../../lib/worktree";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@rev/ui/components/ui/popover";
import { useState } from "react";

export function CwdBlock() {
  const { path, setPath } = useWorktree();
  const [open, setOpen] = useState(false);
  const repos = useQuery({
    ...listGitRepos.queryOptions(),
    enabled: open,
  });

  const handleSelect = (repo: string) => {
    setPath(repo);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {path || "..."}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-auto max-w-md p-1"
      >
        <div className="flex flex-col">
          {repos.isLoading && (
            <span className="px-3 py-2 text-xs text-muted-foreground">
              Scanning...
            </span>
          )}
          {repos.data?.map((repo) => (
            <button
              key={repo}
              type="button"
              onClick={() => handleSelect(repo)}
              className={`text-left px-3 py-1.5 text-xs font-mono rounded-sm hover:bg-accent hover:text-accent-foreground transition-colors ${
                repo === path
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
