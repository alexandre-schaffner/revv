import { Link } from "@tanstack/react-router";
import { Avatar, AvatarImage, AvatarFallback } from "@rev/ui/components/ui/avatar";
import { GitPullRequest, GitPullRequestClosed, GitMerge, GitBranch, User } from "lucide-react";

export interface PrEntry {
  number: number;
  title: string;
  author: { login: string; avatarUrl?: string };
  state: string;
  headRefName: string;
  updatedAt: string;
}

function PrStateIcon({ state }: { state: string }) {
  switch (state) {
    case "MERGED":
      return <GitMerge className="h-3.5 w-3.5 text-purple-500 shrink-0" />;
    case "CLOSED":
      return <GitPullRequestClosed className="h-3.5 w-3.5 text-red-500 shrink-0" />;
    default:
      return <GitPullRequest className="h-3.5 w-3.5 text-green-500 shrink-0" />;
  }
}

export function PRListItem({ pr }: { pr: PrEntry }) {
  return (
    <Link
      to="/pr/$number"
      params={{ number: String(pr.number) }}
      className="flex flex-col gap-1 px-3 py-2 hover:bg-accent/50 transition-colors rounded-md mx-1 cursor-pointer no-underline"
    >
      {/* Line 1: state icon + title */}
      <div className="flex items-center gap-1.5 min-w-0">
        <PrStateIcon state={pr.state} />
        <span className="text-xs text-muted-foreground shrink-0 font-mono">
          #{pr.number}
        </span>
        <span className="text-xs text-foreground truncate font-medium">
          {pr.title}
        </span>
      </div>

      {/* Line 2: author */}
      <div className="flex items-center gap-1.5 min-w-0 pl-5">
        <Avatar className="h-4 w-4 shrink-0">
          {pr.author.avatarUrl ? (
            <AvatarImage src={pr.author.avatarUrl} alt={pr.author.login} />
          ) : null}
          <AvatarFallback className="text-[8px]">
            <User className="h-2.5 w-2.5" />
          </AvatarFallback>
        </Avatar>
        <span className="text-[11px] text-muted-foreground truncate">
          {pr.author.login}
        </span>
      </div>

      {/* Line 3: branch */}
      <div className="flex items-center gap-1.5 min-w-0 pl-5">
        <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-[11px] text-muted-foreground font-mono truncate">
          {pr.headRefName}
        </span>
      </div>
    </Link>
  );
}

export function PRList({
  prs,
  emptyMessage,
}: {
  prs: PrEntry[];
  emptyMessage?: string;
}) {
  if (prs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-xs text-muted-foreground">
          {emptyMessage ?? "No pull requests."}
        </span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-0.5 py-1">
        {prs.map((pr) => (
          <PRListItem key={pr.number} pr={pr} />
        ))}
      </div>
    </div>
  );
}
