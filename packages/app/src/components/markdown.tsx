import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { PatchDiff, File } from "@pierre/diffs/react";
import { useTheme, themes } from "../lib/theme";
import type { BaseDiffOptions } from "@pierre/diffs/react";

interface MarkdownProps {
  children: string;
  className?: string;
}

const remarkPlugins = [remarkGfm];

function useDiffsThemeOptions(): BaseDiffOptions {
  const { theme } = useTheme();
  const meta = themes[theme];
  return useMemo(() => ({
    theme: meta.shikiTheme,
    themeType: meta.dark ? "dark" as const : "light" as const,
  }), [meta.shikiTheme, meta.dark]);
}

/**
 * Validates whether a string looks like a parseable unified diff.
 * Avoids passing partial/malformed diffs to PatchDiff which would throw.
 */
function isCompleteDiff(code: string): boolean {
  // Must have at least one @@ hunk header to be parseable
  if (!code.includes("@@")) return false;
  // Must have at least one +/- line
  if (!code.includes("\n+") && !code.includes("\n-")) return false;
  return true;
}

/**
 * Renders a diff block, falling back to plain <pre> if the diff is incomplete.
 */
function DiffBlock({ code, themeOpts }: { code: string; themeOpts: BaseDiffOptions }) {
  if (!isCompleteDiff(code)) {
    return (
      <pre className="my-4 overflow-x-auto rounded-lg border bg-muted p-4 text-sm font-mono whitespace-pre">
        {code}
      </pre>
    );
  }

  try {
    return (
      <div className="my-4 overflow-hidden rounded-lg border">
        <PatchDiff
          patch={code}
          options={{
            ...themeOpts,
            diffStyle: "unified",
            overflow: "scroll",
            disableFileHeader: !code.startsWith("---"),
            hunkSeparators: "simple",
          }}
        />
      </div>
    );
  } catch {
    return (
      <pre className="my-4 overflow-x-auto rounded-lg border bg-muted p-4 text-sm font-mono whitespace-pre">
        {code}
      </pre>
    );
  }
}

/**
 * Custom code block renderer that routes:
 * - ```diff → @pierre/diffs PatchDiff (with validation for streaming)
 * - ```<lang> → @pierre/diffs File (syntax highlighted)
 * - inline code → <code>
 */
function CodeBlock({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { node?: unknown }) {
  const match = /language-(\w+)/.exec(className || "");
  const lang = match?.[1];
  const code = String(children).replace(/\n$/, "");
  const themeOpts = useDiffsThemeOptions();

  // Inline code (no language class, no block)
  if (!lang) {
    return (
      <code
        className="bg-muted text-foreground rounded px-1.5 py-0.5 text-[0.85em] font-mono"
        {...props}
      >
        {children}
      </code>
    );
  }

  // Diff blocks → PatchDiff (with pre-validation instead of error boundary)
  if (lang === "diff" || lang === "patch") {
    return <DiffBlock code={code} themeOpts={themeOpts} />;
  }

  // All other languages → File (syntax highlighted code viewer)
  return (
    <div className="my-4 overflow-hidden rounded-lg border">
      <File
        file={{
          name: `example.${lang}`,
          contents: code,
          lang,
        }}
        options={{
          ...themeOpts,
          overflow: "scroll",
        }}
      />
    </div>
  );
}

const components = {
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code: CodeBlock,
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-2xl font-bold tracking-tight mt-8 mb-4">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-xl font-semibold tracking-tight mt-6 mb-3">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-lg font-semibold mt-5 mb-2">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-3 leading-relaxed">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-3 ml-6 list-disc space-y-1">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-3 ml-6 list-decimal space-y-1">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="leading-relaxed">{children}</li>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-4 border-l-4 border-primary/30 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href} className="text-primary underline underline-offset-2 hover:text-primary/80">
      {children}
    </a>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-4 overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-muted/50 border-b">{children}</thead>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-4 py-2 text-left font-medium text-muted-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-4 py-2 border-t">{children}</td>
  ),
  hr: () => <hr className="my-6 border-border" />,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em>{children}</em>,
};

export const Markdown = memo(function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={`text-sm ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components as Components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
