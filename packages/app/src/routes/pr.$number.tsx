import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ArrowLeft, Loader2, FileCode } from "lucide-react";
import { Button } from "@rev/ui/components/ui/button";
import { Badge } from "@rev/ui/components/ui/badge";
import { PatchDiff } from "@pierre/diffs/react";
import { Markdown } from "../components/markdown";
import { viewPr, getPrDiff } from "../blocks/prs/commands";
import { useTheme, themes } from "../lib/theme";

export const Route = createFileRoute("/pr/$number")({
  component: PrDetailPage,
});

function stateBadgeVariant(
  state: string,
): "default" | "secondary" | "destructive" {
  switch (state) {
    case "MERGED":
      return "secondary";
    case "CLOSED":
      return "destructive";
    default:
      return "default";
  }
}

function diffFileName(patch: string): string {
  const match = /^diff --git a\/.+ b\/(.+)$/m.exec(patch);
  return match?.[1] ?? "unknown";
}

function LazyFileDiff({ patch }: { patch: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const { theme } = useTheme();
  const meta = themes[theme];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fileName = diffFileName(patch);

  return (
    <div ref={ref} className="rounded-lg border overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b text-xs font-mono text-muted-foreground">
        <FileCode className="h-3.5 w-3.5 shrink-0" />
        {fileName}
      </div>
      {visible ? (
        <PatchDiff
          patch={patch}
          options={{
            theme: meta.shikiTheme,
            themeType: meta.dark ? "dark" : "light",
            diffStyle: "unified",
            overflow: "scroll",
            disableFileHeader: true,
            hunkSeparators: "simple",
          }}
        />
      ) : (
        <div className="h-24 flex items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </div>
      )}
    </div>
  );
}

function PrDetailPage() {
  const { number } = Route.useParams();
  const prNumber = Number(number);

  const prQuery = useQuery(viewPr.queryOptions({ number: prNumber }));
  const diffQuery = useQuery(getPrDiff.queryOptions({ number: prNumber }));

  if (prQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading PR #{prNumber}...</span>
      </div>
    );
  }

  if (prQuery.isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <span className="text-sm text-destructive">
          {prQuery.error instanceof Error
            ? prQuery.error.message
            : "Failed to load PR."}
        </span>
        <Link to="/">
          <Button variant="outline" size="sm">
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
            Back
          </Button>
        </Link>
      </div>
    );
  }

  const detail = prQuery.data;
  if (!detail) return null;

  const files = diffQuery.data ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
        <Link to="/">
          <Button variant="ghost" size="sm" className="h-7 px-2">
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
        </Link>
        <Badge
          variant={stateBadgeVariant(detail.state)}
          className="text-[10px] px-1.5 py-0"
        >
          {detail.state}
        </Badge>
        <span className="text-sm font-medium truncate">{detail.title}</span>
        <span className="text-xs text-muted-foreground font-mono">
          #{prNumber}
        </span>
        <div className="ml-auto">
          <a
            href={detail.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline" size="sm" className="h-7 gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              Open on GitHub
            </Button>
          </a>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {detail.body.trim().length > 0 && (
            <Markdown>{detail.body}</Markdown>
          )}

          {files.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                {files.length} file{files.length !== 1 ? "s" : ""} changed
              </h2>
              {files.map((patch, i) => (
                <LazyFileDiff key={i} patch={patch} />
              ))}
            </div>
          )}

          {diffQuery.isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-xs">Loading diffs...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
