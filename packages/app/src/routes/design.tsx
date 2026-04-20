import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTheme, themes, type ThemeId } from "../lib/theme";
import { useStreamingText } from "../lib/use-streaming-text";
import { Markdown } from "../components/markdown";
import { PatchDiff, MultiFileDiff } from "@pierre/diffs/react";
import type { BaseDiffOptions } from "@pierre/diffs/react";
import { Button } from "@rev/ui/components/ui/button";
import { Badge } from "@rev/ui/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@rev/ui/components/ui/card";
import { Input } from "@rev/ui/components/ui/input";
import { Textarea } from "@rev/ui/components/ui/textarea";
import { Checkbox } from "@rev/ui/components/ui/checkbox";
import { Switch } from "@rev/ui/components/ui/switch";
import { Slider } from "@rev/ui/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rev/ui/components/ui/select";
import { TagInput } from "@rev/ui/components/ui/tag-input";
import { Separator } from "@rev/ui/components/ui/separator";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@rev/ui/components/ui/avatar";
import { Alert, AlertTitle, AlertDescription } from "@rev/ui/components/ui/alert";
import { Skeleton } from "@rev/ui/components/ui/skeleton";
import { Spinner } from "@rev/ui/components/ui/spinner";
import { Kbd } from "@rev/ui/components/ui/kbd";
/* Note: Spinner is also used in StreamingDemo */
import { Toggle } from "@rev/ui/components/ui/toggle";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@rev/ui/components/ui/tabs";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@rev/ui/components/ui/accordion";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@rev/ui/components/ui/tooltip";
import {
  AlertCircle,
  Bold,
  Check,
  Info,
  Italic,
  Mail,
  Terminal,
  Underline,
} from "lucide-react";

export const Route = createFileRoute("/design")({
  component: DesignPage,
});

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Showcase({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      {children}
    </div>
  );
}

// ── Sample data ──

const samplePatch = `--- a/src/lib/auth.ts
+++ b/src/lib/auth.ts
@@ -12,10 +12,15 @@ export class AuthService {
   private tokenStore: Map<string, Token> = new Map();

   async authenticate(credentials: Credentials): Promise<Session> {
-    const token = await this.provider.getToken(credentials);
-    this.tokenStore.set(token.id, token);
+    const token = await this.provider.getToken(credentials, {
+      scope: "read write",
+      expiresIn: "24h",
+    });
+    this.tokenStore.set(token.id, { ...token, createdAt: Date.now() });
     return { token, user: await this.resolveUser(token) };
   }
+
+  isExpired(token: Token): boolean {
+    return Date.now() - token.createdAt > token.expiresIn;
+  }
 }`;

const sampleMarkdown = `## Code Review: Auth Service Refactor

The authentication service was updated to support **scoped tokens** with expiration.

### Key Changes

1. Token creation now accepts \`scope\` and \`expiresIn\` options
2. Tokens are stored with a \`createdAt\` timestamp
3. New \`isExpired()\` helper method

Here's the relevant diff:

\`\`\`diff
--- a/src/lib/auth.ts
+++ b/src/lib/auth.ts
@@ -12,8 +12,11 @@ export class AuthService {
   async authenticate(credentials: Credentials): Promise<Session> {
-    const token = await this.provider.getToken(credentials);
-    this.tokenStore.set(token.id, token);
+    const token = await this.provider.getToken(credentials, {
+      scope: "read write",
+      expiresIn: "24h",
+    });
+    this.tokenStore.set(token.id, { ...token, createdAt: Date.now() });
     return { token, user: await this.resolveUser(token) };
   }
\`\`\`

### Usage Example

\`\`\`typescript
const auth = new AuthService(provider);
const session = await auth.authenticate({ email, password });

if (auth.isExpired(session.token)) {
  console.log("Session expired, re-authenticating...");
}
\`\`\`

> **Note:** The \`expiresIn\` value is parsed as a duration string (e.g. \`"24h"\`, \`"7d"\`).

| Property | Type | Default |
|----------|------|---------|
| scope | \`string\` | \`"read"\` |
| expiresIn | \`string\` | \`"1h"\` |
| refreshable | \`boolean\` | \`false\` |
`;

const streamingMarkdown = `## Analyzing your pull request...

I've reviewed the changes in \`src/lib/auth.ts\`. Here's my analysis:

### Summary

This PR refactors the authentication flow to support **scoped tokens with TTL**. The changes are well-structured and backwards-compatible.

### Diff walkthrough

The core change is in the \`authenticate\` method:

\`\`\`diff
--- a/src/lib/auth.ts
+++ b/src/lib/auth.ts
@@ -14,5 +14,8 @@ export class AuthService {
-    const token = await this.provider.getToken(credentials);
+    const token = await this.provider.getToken(credentials, {
+      scope: "read write",
+      expiresIn: "24h",
+    });
\`\`\`

### Suggestions

1. Consider adding a **refresh token** mechanism for long-lived sessions
2. The \`isExpired\` check should handle clock skew gracefully:

\`\`\`typescript
isExpired(token: Token, skewMs = 30_000): boolean {
  return Date.now() - token.createdAt > token.expiresIn - skewMs;
}
\`\`\`

Overall this looks **good to merge** with the minor suggestions above.
`;

function StreamingDemo() {
  const [running, setRunning] = useState(false);
  const { text, isStreaming, isDone, start } = useStreamingText(streamingMarkdown, {
    autoStart: false,
    interval: 12,
    chunkSize: { min: 2, max: 6 },
  });

  return (
    <Section title="Streaming Markdown (LLM simulation)">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">AI Review Output</CardTitle>
              <CardDescription>
                Simulates token-by-token LLM streaming. Markdown and diffs render progressively.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant={isStreaming ? "secondary" : "default"}
              onClick={() => { setRunning(true); start(); }}
              disabled={isStreaming}
            >
              {isStreaming ? (
                <><Spinner className="mr-2" /> Streaming...</>
              ) : isDone && running ? (
                "Restart"
              ) : (
                "Start stream"
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {running ? (
            <div className="min-h-[200px]">
              <Markdown>{text}</Markdown>
              {isStreaming && (
                <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom" />
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
              Click "Start stream" to simulate LLM output
            </div>
          )}
        </CardContent>
      </Card>
    </Section>
  );
}

const themeSwatches: Record<ThemeId, string> = {
  "zinc-light": "bg-white border border-zinc-300",
  "zinc-dark": "bg-zinc-900 border border-zinc-700",
  "catppuccin-latte": "bg-[#eff1f5] border border-[#acb0be]",
  "catppuccin-mocha": "bg-[#1e1e2e] border border-[#585b70]",
  "gruvbox-light": "bg-[#fbf1c7] border border-[#d5c4a1]",
  "gruvbox-dark": "bg-[#282828] border border-[#504945]",
};

const syntaxTokens = [
  { name: "keyword", cls: "text-syntax-keyword", example: "import" },
  { name: "string", cls: "text-syntax-string", example: '"hello"' },
  { name: "comment", cls: "text-syntax-comment", example: "// note" },
  { name: "function", cls: "text-syntax-function", example: "render()" },
  { name: "variable", cls: "text-syntax-variable", example: "count" },
  { name: "type", cls: "text-syntax-type", example: "string" },
  { name: "constant", cls: "text-syntax-constant", example: "true" },
  { name: "number", cls: "text-syntax-number", example: "42" },
  { name: "operator", cls: "text-syntax-operator", example: "===" },
  { name: "punctuation", cls: "text-syntax-punctuation", example: "{ }" },
  { name: "tag", cls: "text-syntax-tag", example: "<div>" },
  { name: "attribute", cls: "text-syntax-attribute", example: "class=" },
  { name: "regex", cls: "text-syntax-regex", example: "/ab+c/" },
  { name: "added", cls: "text-syntax-added", example: "+ new" },
  { name: "deleted", cls: "text-syntax-deleted", example: "- old" },
];

const ansiColors = [
  { name: "black", cls: "bg-ansi-black" },
  { name: "red", cls: "bg-ansi-red" },
  { name: "green", cls: "bg-ansi-green" },
  { name: "yellow", cls: "bg-ansi-yellow" },
  { name: "blue", cls: "bg-ansi-blue" },
  { name: "magenta", cls: "bg-ansi-magenta" },
  { name: "cyan", cls: "bg-ansi-cyan" },
  { name: "white", cls: "bg-ansi-white" },
];

const ansiBrightColors = [
  { name: "br-black", cls: "bg-ansi-bright-black" },
  { name: "br-red", cls: "bg-ansi-bright-red" },
  { name: "br-green", cls: "bg-ansi-bright-green" },
  { name: "br-yellow", cls: "bg-ansi-bright-yellow" },
  { name: "br-blue", cls: "bg-ansi-bright-blue" },
  { name: "br-magenta", cls: "bg-ansi-bright-magenta" },
  { name: "br-cyan", cls: "bg-ansi-bright-cyan" },
  { name: "br-white", cls: "bg-ansi-bright-white" },
];

const chainSuggestions = [
  "Ethereum",
  "Arbitrum",
  "Optimism",
  "Polygon",
  "Base",
  "Avalanche",
  "BNB Chain",
  "Solana",
  "Fantom",
  "zkSync",
  "Scroll",
  "Linea",
  "Starknet",
  "Cosmos",
];

function TagInputDemo() {
  const [chains, setChains] = useState<string[]>([]);
  return (
    <TagInput
      value={chains}
      onChange={setChains}
      suggestions={chainSuggestions}
      placeholder="Add chains..."
    />
  );
}

function DesignPage() {
  const { theme, setTheme } = useTheme();
  const meta = themes[theme];
  const diffsOptions: BaseDiffOptions = {
    theme: meta.shikiTheme,
    themeType: meta.dark ? "dark" : "light",
  };

  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-8 py-10 space-y-12">
          <header className="flex items-start justify-between gap-6">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Design System</h1>
              <p className="text-muted-foreground mt-1">
                Component showcase for <code className="text-xs bg-muted px-1.5 py-0.5 rounded">@rev/ui</code>
              </p>
            </div>
            <div className="flex items-center gap-1.5 bg-muted rounded-lg p-1">
              {(Object.keys(themes) as ThemeId[]).map((id) => (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setTheme(id)}
                      className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${
                        theme === id
                          ? "ring-2 ring-primary ring-offset-1 ring-offset-background scale-110"
                          : "hover:scale-105"
                      }`}
                    >
                      <span className={`w-4 h-4 rounded-full ${themeSwatches[id]}`} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {themes[id].label} {themes[id].dark ? "(dark)" : "(light)"}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </header>

          {/* ── Diff Viewer (@pierre/diffs) ── */}
          <Section title="Diff Viewer">
            <div className="space-y-6">
              <Showcase label="Unified diff from patch string">
                <div className="rounded-lg border overflow-hidden">
                  <PatchDiff
                    patch={samplePatch}
                    options={{
                      ...diffsOptions,
                      diffStyle: "unified",
                      overflow: "scroll",
                      hunkSeparators: "simple",
                    }}
                  />
                </div>
              </Showcase>

              <Showcase label="Side-by-side diff">
                <div className="rounded-lg border overflow-hidden">
                  <MultiFileDiff
                    oldFile={{
                      name: "config.ts",
                      contents: `export const config = {\n  port: 3000,\n  host: "localhost",\n  debug: false,\n  logLevel: "info",\n};`,
                    }}
                    newFile={{
                      name: "config.ts",
                      contents: `export const config = {\n  port: 8080,\n  host: "0.0.0.0",\n  debug: true,\n  logLevel: "debug",\n  timeout: 5000,\n};`,
                    }}
                    options={{
                      ...diffsOptions,
                      diffStyle: "split",
                      overflow: "scroll",
                      hunkSeparators: "simple",
                    }}
                  />
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Rich Markdown ── */}
          <Section title="Rich Markdown">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Rendered Markdown with embedded diffs</CardTitle>
                <CardDescription>
                  Code blocks use @pierre/diffs for syntax highlighting. <code className="text-xs bg-muted px-1 py-0.5 rounded">```diff</code> blocks render as interactive diffs.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Markdown>{sampleMarkdown}</Markdown>
              </CardContent>
            </Card>
          </Section>

          <Separator />

          {/* ── Streaming Demo ── */}
          <StreamingDemo />

          <Separator />

          {/* ── Syntax Highlighting ── */}
          <Section title="Syntax Highlighting">
            <Card>
              <CardContent className="pt-6">
                <div className="grid grid-cols-3 gap-x-6 gap-y-2">
                  {syntaxTokens.map(({ name, cls, example }) => (
                    <div key={name} className="flex items-center justify-between gap-3 py-1">
                      <span className="text-xs text-muted-foreground font-mono">{name}</span>
                      <code className={`text-sm font-mono font-medium ${cls}`}>{example}</code>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Live code preview */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Code Preview</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-sm font-mono leading-relaxed bg-background rounded-md p-4 border">
                  <span className="text-syntax-keyword">import</span>
                  <span className="text-syntax-punctuation">{" { "}</span>
                  <span className="text-syntax-variable">useState</span>
                  <span className="text-syntax-punctuation">{" } "}</span>
                  <span className="text-syntax-keyword">from</span>
                  <span className="text-syntax-string"> "react"</span>
                  <span className="text-syntax-punctuation">;</span>
                  {"\n\n"}
                  <span className="text-syntax-comment">{"// A simple counter component"}</span>
                  {"\n"}
                  <span className="text-syntax-keyword">export function</span>
                  <span className="text-syntax-function"> Counter</span>
                  <span className="text-syntax-punctuation">{"("}</span>
                  <span className="text-syntax-punctuation">{")"}</span>
                  <span className="text-syntax-punctuation">{" {"}</span>
                  {"\n  "}
                  <span className="text-syntax-keyword">const</span>
                  <span className="text-syntax-punctuation"> [</span>
                  <span className="text-syntax-variable">count</span>
                  <span className="text-syntax-punctuation">, </span>
                  <span className="text-syntax-function">setCount</span>
                  <span className="text-syntax-punctuation">]</span>
                  <span className="text-syntax-operator"> = </span>
                  <span className="text-syntax-function">useState</span>
                  <span className="text-syntax-punctuation">(</span>
                  <span className="text-syntax-number">0</span>
                  <span className="text-syntax-punctuation">);</span>
                  {"\n  "}
                  <span className="text-syntax-keyword">const</span>
                  <span className="text-syntax-variable"> max</span>
                  <span className="text-syntax-punctuation">: </span>
                  <span className="text-syntax-type">number</span>
                  <span className="text-syntax-operator"> = </span>
                  <span className="text-syntax-number">100</span>
                  <span className="text-syntax-punctuation">;</span>
                  {"\n  "}
                  <span className="text-syntax-keyword">const</span>
                  <span className="text-syntax-variable"> active</span>
                  <span className="text-syntax-operator"> = </span>
                  <span className="text-syntax-constant">true</span>
                  <span className="text-syntax-punctuation">;</span>
                  {"\n\n  "}
                  <span className="text-syntax-keyword">return</span>
                  <span className="text-syntax-punctuation"> (</span>
                  {"\n    "}
                  <span className="text-syntax-tag">{"<"}</span>
                  <span className="text-syntax-tag">button</span>
                  <span className="text-syntax-attribute"> onClick</span>
                  <span className="text-syntax-operator">{"="}</span>
                  <span className="text-syntax-punctuation">{"{"}</span>
                  <span className="text-syntax-punctuation">() </span>
                  <span className="text-syntax-operator">{"=>"}</span>
                  <span className="text-syntax-function"> setCount</span>
                  <span className="text-syntax-punctuation">(</span>
                  <span className="text-syntax-variable">count</span>
                  <span className="text-syntax-operator"> + </span>
                  <span className="text-syntax-number">1</span>
                  <span className="text-syntax-punctuation">)</span>
                  <span className="text-syntax-punctuation">{"}"}</span>
                  <span className="text-syntax-tag">{">"}</span>
                  {"\n      "}
                  <span className="text-syntax-variable">{"Count: {count}"}</span>
                  {"\n    "}
                  <span className="text-syntax-tag">{"</"}</span>
                  <span className="text-syntax-tag">button</span>
                  <span className="text-syntax-tag">{">"}</span>
                  {"\n  "}
                  <span className="text-syntax-punctuation">);</span>
                  {"\n"}
                  <span className="text-syntax-punctuation">{"}"}</span>
                </pre>
              </CardContent>
            </Card>
          </Section>

          <Separator />

          {/* ── ANSI Terminal Colors ── */}
          <Section title="ANSI Terminal Colors">
            <div className="grid grid-cols-2 gap-6">
              <Showcase label="Standard (0-7)">
                <div className="grid grid-cols-8 gap-1.5">
                  {ansiColors.map(({ name, cls }) => (
                    <div key={name} className="space-y-1">
                      <div className={`h-8 rounded-md ${cls}`} />
                      <p className="text-[9px] text-muted-foreground text-center font-mono">{name}</p>
                    </div>
                  ))}
                </div>
              </Showcase>

              <Showcase label="Bright (8-15)">
                <div className="grid grid-cols-8 gap-1.5">
                  {ansiBrightColors.map(({ name, cls }) => (
                    <div key={name} className="space-y-1">
                      <div className={`h-8 rounded-md ${cls}`} />
                      <p className="text-[9px] text-muted-foreground text-center font-mono">{name}</p>
                    </div>
                  ))}
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Diff Colors ── */}
          <Section title="Diff Colors">
            <Card>
              <CardContent className="pt-6 font-mono text-sm">
                <div className="rounded-md border overflow-hidden">
                  <div className="bg-diff-add-bg text-diff-add-fg px-4 py-1">+ const greeting = "hello world";</div>
                  <div className="bg-diff-add-bg text-diff-add-fg px-4 py-1">+ const version = 2;</div>
                  <div className="px-4 py-1">  export default greeting;</div>
                  <div className="bg-diff-del-bg text-diff-del-fg px-4 py-1">- const legacy = true;</div>
                  <div className="bg-diff-del-bg text-diff-del-fg px-4 py-1">- const oldApi = "/v1";</div>
                  <div className="bg-diff-change-bg px-4 py-1">~ const api = "/v2"; {/* changed */}</div>
                </div>
              </CardContent>
            </Card>
          </Section>

          <Separator />

          {/* ── UI Colors ── */}
          <Section title="UI Colors">
            <div className="grid grid-cols-2 gap-6">
              <Showcase label="Theme colors">
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { name: "Background", cls: "bg-background border" },
                    { name: "Foreground", cls: "bg-foreground" },
                    { name: "Primary", cls: "bg-primary" },
                    { name: "Secondary", cls: "bg-secondary border" },
                    { name: "Muted", cls: "bg-muted border" },
                    { name: "Accent", cls: "bg-accent border" },
                    { name: "Destructive", cls: "bg-destructive" },
                    { name: "Card", cls: "bg-card border" },
                  ].map(({ name, cls }) => (
                    <div key={name} className="space-y-1.5">
                      <div className={`h-10 rounded-md ${cls}`} />
                      <p className="text-[10px] text-muted-foreground text-center">{name}</p>
                    </div>
                  ))}
                </div>
              </Showcase>

              <Showcase label="Semantic colors">
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { name: "Border", cls: "bg-border" },
                    { name: "Input", cls: "bg-input" },
                    { name: "Ring", cls: "bg-ring" },
                    { name: "Popover", cls: "bg-popover border" },
                  ].map(({ name, cls }) => (
                    <div key={name} className="space-y-1.5">
                      <div className={`h-10 rounded-md ${cls}`} />
                      <p className="text-[10px] text-muted-foreground text-center">{name}</p>
                    </div>
                  ))}
                </div>
              </Showcase>
            </div>
          </Section>

          {/* ── Typography ── */}
          <Section title="Typography">
            <Card>
              <CardContent className="pt-6 space-y-3">
                <p className="text-4xl font-bold tracking-tight">Heading 1</p>
                <p className="text-3xl font-semibold tracking-tight">Heading 2</p>
                <p className="text-2xl font-semibold tracking-tight">Heading 3</p>
                <p className="text-xl font-semibold">Heading 4</p>
                <p className="text-lg font-medium">Large text</p>
                <p className="text-base">Body text - The quick brown fox jumps over the lazy dog.</p>
                <p className="text-sm text-muted-foreground">Small / muted text</p>
                <p className="text-xs text-muted-foreground">Extra small caption</p>
                <p className="font-mono text-sm">Monospace: const x = 42;</p>
              </CardContent>
            </Card>
          </Section>

          <Separator />

          {/* ── Buttons ── */}
          <Section title="Buttons">
            <div className="grid grid-cols-2 gap-6">
              <Showcase label="Variants">
                <div className="flex flex-wrap gap-2">
                  <Button variant="default">Default</Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="destructive">Destructive</Button>
                  <Button variant="link">Link</Button>
                </div>
              </Showcase>

              <Showcase label="Sizes">
                <div className="flex items-center gap-2">
                  <Button size="sm">Small</Button>
                  <Button size="default">Default</Button>
                  <Button size="lg">Large</Button>
                  <Button size="icon"><Mail className="h-4 w-4" /></Button>
                </div>
              </Showcase>

              <Showcase label="States">
                <div className="flex flex-wrap gap-2">
                  <Button>Enabled</Button>
                  <Button disabled>Disabled</Button>
                  <Button variant="outline" disabled>Disabled outline</Button>
                </div>
              </Showcase>

              <Showcase label="With icons">
                <div className="flex flex-wrap gap-2">
                  <Button><Mail className="mr-2 h-4 w-4" /> Login with Email</Button>
                  <Button variant="outline"><Check className="mr-2 h-4 w-4" /> Approve</Button>
                  <Button variant="destructive"><AlertCircle className="mr-2 h-4 w-4" /> Delete</Button>
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Badges ── */}
          <Section title="Badges">
            <div className="flex flex-wrap gap-2">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge variant="outline">Outline</Badge>
            </div>
          </Section>

          <Separator />

          {/* ── Form Controls ── */}
          <Section title="Form Controls">
            <div className="grid grid-cols-2 gap-6">
              <Showcase label="Input">
                <div className="space-y-2">
                  <Input placeholder="Default input" />
                  <Input type="email" placeholder="Email" />
                  <Input disabled placeholder="Disabled" />
                </div>
              </Showcase>

              <Showcase label="Textarea">
                <Textarea placeholder="Type your message here..." />
              </Showcase>

              <Showcase label="Tag Input">
                <TagInputDemo />
              </Showcase>

              <Showcase label="Checkbox, Switch & Slider">
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Checkbox id="terms" />
                    <label htmlFor="terms" className="text-sm">Accept terms</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox id="disabled" disabled />
                    <label htmlFor="disabled" className="text-sm text-muted-foreground">Disabled</label>
                  </div>
                  <Separator />
                  <div className="flex items-center gap-3">
                    <Switch id="airplane" />
                    <label htmlFor="airplane" className="text-sm">Airplane mode</label>
                  </div>
                  <Separator />
                  <Slider defaultValue={[50]} max={100} step={1} className="w-full" />
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Cards ── */}
          <Section title="Cards">
            <div className="grid grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Card Title</CardTitle>
                  <CardDescription>Card description with supporting text.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm">
                    This is the card content area. Use it for any kind of body content.
                  </p>
                </CardContent>
                <CardFooter className="gap-2">
                  <Button variant="outline" size="sm">Cancel</Button>
                  <Button size="sm">Save</Button>
                </CardFooter>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Notifications</CardTitle>
                  <CardDescription>You have 3 unread messages.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {["New review comment", "PR approved", "Build succeeded"].map((msg) => (
                    <div key={msg} className="flex items-center gap-3">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                      <p className="text-sm">{msg}</p>
                    </div>
                  ))}
                </CardContent>
                <CardFooter>
                  <Button variant="outline" size="sm" className="w-full">
                    <Check className="mr-2 h-4 w-4" /> Mark all as read
                  </Button>
                </CardFooter>
              </Card>
            </div>
          </Section>

          <Separator />

          {/* ── Alerts ── */}
          <Section title="Alerts">
            <div className="space-y-3">
              <Alert>
                <Terminal className="h-4 w-4" />
                <AlertTitle>Heads up!</AlertTitle>
                <AlertDescription>
                  You can add components to your app using the CLI.
                </AlertDescription>
              </Alert>
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>
                  Your session has expired. Please log in again.
                </AlertDescription>
              </Alert>
            </div>
          </Section>

          <Separator />

          {/* ── Data Display ── */}
          <Section title="Data Display">
            <div className="grid grid-cols-3 gap-6">
              <Showcase label="Avatars">
                <div className="flex items-center gap-3">
                  <Avatar>
                    <AvatarImage src="https://github.com/shadcn.png" alt="shadcn" />
                    <AvatarFallback>CN</AvatarFallback>
                  </Avatar>
                  <Avatar>
                    <AvatarFallback>AB</AvatarFallback>
                  </Avatar>
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-xs">SM</AvatarFallback>
                  </Avatar>
                </div>
              </Showcase>

              <Showcase label="Keyboard shortcuts">
                <div className="flex items-center gap-2">
                  <Kbd>Ctrl</Kbd>
                  <span className="text-xs text-muted-foreground">+</span>
                  <Kbd>K</Kbd>
                  <span className="text-xs text-muted-foreground ml-4">or</span>
                  <Kbd>Esc</Kbd>
                </div>
              </Showcase>

              <Showcase label="Tooltips">
                <div className="flex gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="sm">
                        <Info className="mr-2 h-3 w-3" /> Hover me
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>This is a tooltip</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Toggle ── */}
          <Section title="Toggle">
            <div className="flex gap-2">
              <Toggle aria-label="Toggle bold">
                <Bold className="h-4 w-4" />
              </Toggle>
              <Toggle aria-label="Toggle italic">
                <Italic className="h-4 w-4" />
              </Toggle>
              <Toggle aria-label="Toggle underline">
                <Underline className="h-4 w-4" />
              </Toggle>
              <Separator orientation="vertical" className="mx-1 h-10" />
              <Toggle variant="outline" aria-label="Toggle outline">
                <Bold className="h-4 w-4" />
              </Toggle>
            </div>
          </Section>

          <Separator />

          {/* ── Tabs ── */}
          <Section title="Tabs">
            <Tabs defaultValue="preview" className="w-full">
              <TabsList>
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="code">Code</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <TabsContent value="preview">
                <Card>
                  <CardContent className="pt-6">
                    <p className="text-sm text-muted-foreground">
                      This is the preview tab content. Switch tabs to see other content.
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="code">
                <Card>
                  <CardContent className="pt-6">
                    <pre className="text-sm font-mono bg-muted p-3 rounded-md">
                      {`import { Button } from "@rev/ui"\n\nexport function App() {\n  return <Button>Click me</Button>\n}`}
                    </pre>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="settings">
                <Card>
                  <CardContent className="pt-6 space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm">Dark mode</label>
                      <Switch />
                    </div>
                    <div className="flex items-center justify-between">
                      <label className="text-sm">Notifications</label>
                      <Switch defaultChecked />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </Section>

          <Separator />

          {/* ── Accordion ── */}
          <Section title="Accordion">
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="item-1">
                <AccordionTrigger>What components are included?</AccordionTrigger>
                <AccordionContent>
                  Button, Badge, Card, Input, Textarea, Select, Checkbox, Switch, Slider,
                  Tabs, Accordion, Avatar, Alert, Tooltip, Toggle, Separator, Skeleton, Spinner, and Kbd.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-2">
                <AccordionTrigger>What themes are available?</AccordionTrigger>
                <AccordionContent>
                  Zinc (light/dark), Catppuccin Latte & Mocha, and Gruvbox (light/dark).
                  Each theme defines UI colors, syntax highlighting, ANSI terminal palette, and diff colors.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-3">
                <AccordionTrigger>How do I add a new theme?</AccordionTrigger>
                <AccordionContent>
                  Add a new <code className="text-xs bg-muted px-1 py-0.5 rounded">.theme-*</code> class
                  in <code className="text-xs bg-muted px-1 py-0.5 rounded">globals.css</code> with
                  all the CSS variables, then register it in <code className="text-xs bg-muted px-1 py-0.5 rounded">theme.tsx</code>.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </Section>

          <Separator />

          {/* ── Loading States ── */}
          <Section title="Loading States">
            <div className="grid grid-cols-2 gap-6">
              <Showcase label="Skeleton">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                  <Skeleton className="h-24 w-full" />
                </div>
              </Showcase>

              <Showcase label="Spinner">
                <div className="flex items-center gap-4">
                  <Spinner className="size-4" />
                  <Spinner className="size-6" />
                  <Spinner className="size-8" />
                  <Button disabled>
                    <Spinner className="mr-2" /> Loading...
                  </Button>
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Separator ── */}
          <Section title="Separators">
            <div className="space-y-4">
              <div>
                <p className="text-sm mb-2">Horizontal</p>
                <Separator />
              </div>
              <div className="flex items-center gap-4 h-6">
                <p className="text-sm">Item 1</p>
                <Separator orientation="vertical" />
                <p className="text-sm">Item 2</p>
                <Separator orientation="vertical" />
                <p className="text-sm">Item 3</p>
              </div>
            </div>
          </Section>

          <div className="h-10" />
        </div>
      </div>
    </TooltipProvider>
  );
}
